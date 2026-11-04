// Classic ESP32 / Arduino-ESP32 2.0.17. See config.h before wiring.
#include <Arduino.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <driver/dac.h>
#include <esp_timer.h>
#include <atomic>
#include "config.h"
#if !CONFIG_IDF_TARGET_ESP32
#error Requires classic ESP32 GPIO25 DAC
#endif
static_assert(MAX_DAC_AMPLITUDE > 0 && MAX_DAC_AMPLITUDE <= 127, "DAC limit");
const char *SERVICE = "f3f1a000-7c5b-4f18-b0bb-7d9cb9d00001";
const char *NOTIFY = "f3f1a001-7c5b-4f18-b0bb-7d9cb9d00001";
const char *CONTROL = "f3f1a002-7c5b-4f18-b0bb-7d9cb9d00001";
const char *INFO = "f3f1a003-7c5b-4f18-b0bb-7d9cb9d00001";
BLECharacteristic *notifyChar;
QueueHandle_t rxQueue, txQueue;
std::atomic<bool> connected(false), advertiseAgain(false);
std::atomic<uint32_t> generation(0);
portMUX_TYPE outputMux = portMUX_INITIALIZER_UNLOCKED;
struct OutputState {
  bool active = false;
  float hz = 30, level = 0;
  int64_t deadline = 0, lease = 0;
} output;
struct Frame { uint32_t generation; char text[1400]; };
bool imuFound = false, imuReady = false, powerReady = false, sweeping = false;
// MPU6050 sampling is enabled only while a sweep is being prepared or run.
bool imuReportEnabled = false;
bool inaConfigured = false;
uint8_t powerReadFailures = 0;
uint8_t mpuAddress = 0, inaAddress = 0;
uint32_t lastSensorRetry = 0, imuInitAt = 0, lastMpuReadAt = 0;
uint8_t mpuNoResponseCycles = 0;
constexpr uint32_t SENSOR_RETRY_MS = 5000;
constexpr uint32_t IMU_SAMPLE_INTERVAL_MS = 4; // 250 Hz: >6 samples/cycle at 40 Hz.
// The IMU gets a shorter retry interval while it is offline; the healthy
// INA226 continues being read once per telemetry window.
constexpr uint32_t MPU_OFFLINE_RETRY_MS = 2000;
constexpr uint8_t MPU_BUS_RECOVERY_AFTER_MISSES = 2;
// Give the MPU6050 board a stable supply before its first I2C configuration.
constexpr uint32_t SENSOR_COLD_STARTUP_DELAY_MS = 1000;
constexpr uint32_t MPU_BOOT_DELAY_MS = 100;
String sessionId, bootId, recentIds[8], recentAcks[8];
unsigned recentNext = 0;
uint32_t sequence = 0, lastImu = 0, windowStart = 0, sampleCount = 0, seenGeneration = 0;
double sumSquares = 0;
float ax = 0, ay = 0, az = 0, voltage = 0, current = 0;
// Basic-frequency measurement state. The browser requests this with a BLE
// "measure" command after it has changed the external audio frequency.
constexpr uint32_t MEASUREMENT_SETTLE_MS = 800, MEASUREMENT_CAPTURE_MS = 1600;
constexpr size_t MEASUREMENT_MAX_SAMPLES = 520;
constexpr float MEASUREMENT_MIN_SAMPLES_PER_CYCLE = 5.0f;
enum MeasurementState { MEASUREMENT_IDLE, MEASUREMENT_SETTLING, MEASUREMENT_CAPTURING, MEASUREMENT_COMPLETE, MEASUREMENT_INVALID };
struct FundamentalMeasurement { MeasurementState state = MEASUREMENT_IDLE; float hz = 0; uint32_t startedAt = 0; uint64_t time[MEASUREMENT_MAX_SAMPLES], sensorTime[MEASUREMENT_MAX_SAMPLES]; float value[MEASUREMENT_MAX_SAMPLES]; size_t count = 0; bool sensorClockValid = true; float rms = NAN, r2 = NAN, rate = NAN, mean = NAN, rawAcRms = NAN, residualRms = NAN, bestFitHz = NAN, bestFitR2 = NAN; const char *quality = nullptr; } measurement;
constexpr char MEASUREMENT_AXIS = 'Z';
// Keep this function after project types so Arduino IDE's generated
// declarations do not reference OutputState or Frame before their definition.
size_t getArduinoLoopTaskStackSize() { return 16 * 1024; }

OutputState outputSnapshot() {
  portENTER_CRITICAL(&outputMux); OutputState s = output; portEXIT_CRITICAL(&outputMux); return s;
}
void stopOutput() {
  portENTER_CRITICAL(&outputMux); output.active = false; portEXIT_CRITICAL(&outputMux);
}
void waveTick(void *) {
  static int64_t previous = 0;
  static double phase = 0;
  int64_t now = esp_timer_get_time();
  portENTER_CRITICAL(&outputMux);
  if (!connected.load() || now >= output.deadline || now >= output.lease) output.active = false;
  OutputState s = output;
  portEXIT_CRITICAL(&outputMux);
  if (s.active && previous) phase = fmod(phase + (now - previous) * s.hz / 1000000.0, 1.0);
  else phase = 0;
  previous = now;
  // Midpoint is NOT zero volts or a physical power disconnect.
  if (OUTPUT_ENABLED) dac_output_voltage(DAC_CHANNEL_1,
    uint8_t(lround(128 + (s.active ? sin(phase * TWO_PI) * MAX_DAC_AMPLITUDE * s.level / 100 : 0))));
}
bool enqueue(JsonDocument &doc) {
  Frame frame{}; frame.generation = generation.load();
  if (measureJson(doc) + 2 >= sizeof(frame.text)) { stopOutput(); return false; }
  size_t length = serializeJson(doc, frame.text, sizeof(frame.text));
  frame.text[length] = '\n'; frame.text[length + 1] = 0;
  if (xQueueSend(txQueue, &frame, 0) != pdTRUE) { stopOutput(); return false; }
  return true;
}
void transmit(void *) {
  Frame frame;
  for (;;) {
    if (xQueueReceive(txQueue, &frame, portMAX_DELAY) != pdTRUE) continue;
    for (size_t offset = 0, length = strlen(frame.text); offset < length; offset += 20) {
      if (!connected.load() || frame.generation != generation.load()) break;
      size_t count = min(size_t(20), length - offset);
      notifyChar->setValue((uint8_t *)frame.text + offset, count); notifyChar->notify();
      // Keep notification fragments ordered on mobile Web Bluetooth stacks.
      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
}
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { stopOutput(); generation++; connected = true; Serial.println("BLE: connected"); }
  void onDisconnect(BLEServer *) override { connected = false; generation++; stopOutput(); advertiseAgain = true; Serial.println("BLE: disconnected"); }
};
class ControlCallbacks : public BLECharacteristicCallbacks {
  String buffer;
  uint32_t seen = 0, lastByte = 0;
  bool discard = false;
  void onWrite(BLECharacteristic *characteristic) override {
    if (seen != generation.load() || millis() - lastByte > 2000) {
      buffer = ""; discard = false; seen = generation.load();
    }
    lastByte = millis();
    auto bytes = characteristic->getValue();
    for (char ch : bytes) {
      if (ch == '\n') {
        if (!discard && buffer.length()) {
          Frame frame{}; frame.generation = seen;
          buffer.toCharArray(frame.text, sizeof(frame.text));
          if (xQueueSend(rxQueue, &frame, 0) != pdTRUE) stopOutput();
        }
        buffer = ""; discard = false;
      } else if (!discard) {
        if (buffer.length() >= 1024) { buffer = ""; discard = true; stopOutput(); }
        else buffer += ch;
      }
    }
  }
};
bool readRegister(uint8_t address, uint8_t reg, uint16_t &value) {
  Wire.beginTransmission(address); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, uint8_t(2)) != 2) return false;
  value = (uint16_t(Wire.read()) << 8) | Wire.read(); return true;
}
bool writeRegister(uint8_t address, uint8_t reg, uint16_t value) {
  Wire.beginTransmission(address); Wire.write(reg); Wire.write(value >> 8); Wire.write(value & 255);
  return Wire.endTransmission() == 0;
}
void readPower() {
  uint16_t bus, shunt;
  // Identity is checked during discovery. Re-reading both ID registers every
  // second quadruples I2C work and makes a single transient read look fatal.
  const bool valid = inaConfigured && inaAddress && readRegister(inaAddress, 0x02, bus) &&
    readRegister(inaAddress, 0x01, shunt);
  if (valid) {
    powerReadFailures = 0; powerReady = true;
    voltage = bus * 0.00125f;
    current = SHUNT_OHMS > 0 ? int16_t(shunt) * 0.0000025f / SHUNT_OHMS : 0;
  } else if (inaConfigured) {
    // One failed transaction must not turn a valid INA226 reading into a
    // visible 0.  Preserve the last confirmed value until repeated failures.
    if (++powerReadFailures >= 3) {
      inaConfigured = false; inaAddress = 0; powerReadFailures = 0; powerReady = false;
      Serial.println("INA226: three consecutive reads failed; retrying configuration");
    } else { powerReady = true; Serial.println("INA226: transient read failure; retaining last confirmed value"); }
  } else powerReady = false;
}
void resetWindow() { sumSquares = 0; sampleCount = 0; windowStart = millis(); }
bool solve3x3(double a[3][4], double x[3]) { for (int k=0;k<3;++k) { int b=k; for(int r=k+1;r<3;++r) if(fabs(a[r][k])>fabs(a[b][k])) b=r; if(fabs(a[b][k])<1e-9) return false; for(int j=k;j<4;++j){double t=a[k][j];a[k][j]=a[b][j];a[b][j]=t;} double d=a[k][k]; for(int j=k;j<4;++j)a[k][j]/=d; for(int r=0;r<3;++r)if(r!=k){double q=a[r][k];for(int j=k;j<4;++j)a[r][j]-=q*a[k][j];}} for(int k=0;k<3;++k)x[k]=a[k][3]; return true; }
void startMeasurement(float hz) { measurement.state=MEASUREMENT_SETTLING; measurement.hz=hz; measurement.startedAt=millis(); measurement.count=0; measurement.sensorClockValid=true; measurement.rms=NAN; measurement.r2=NAN; measurement.rate=NAN; measurement.mean=NAN; measurement.rawAcRms=NAN; measurement.residualRms=NAN; measurement.bestFitHz=NAN; measurement.bestFitR2=NAN; measurement.quality="SETTLING"; Serial.printf("MEASURE: start %.1f Hz\n", hz); }
void prepareMeasurementTimes() {
  // Prefer the sensor's acquisition time, which is unaffected by host-side
  // I2C/BLE scheduling. Fall back to one consistent ESP32 clock for the whole
  // capture if any sensor timestamp is missing or non-monotonic.
  if (measurement.sensorClockValid && measurement.count > 1)
    for (size_t i = 0; i < measurement.count; ++i) measurement.time[i] = measurement.sensorTime[i];
}
bool fitAtFrequency(double hz, double &r2, double &rms, double &residualRms) {
  if (measurement.count < 64 || hz <= 0) return false;
  const uint64_t t0 = measurement.time[0];
  double normal[3][3] = {{0}}, rhs[3] = {0}, mean = 0;
  for (size_t i = 0; i < measurement.count; ++i) {
    const double t = (measurement.time[i] - t0) * 1e-6;
    const double angle = TWO_PI * hz * t;
    const double x[3] = {1.0, cos(angle), sin(angle)};
    const double y = measurement.value[i]; mean += y;
    for (int row = 0; row < 3; ++row) {
      rhs[row] += x[row] * y;
      for (int col = 0; col < 3; ++col) normal[row][col] += x[row] * x[col];
    }
  }
  mean /= measurement.count;
  double augmented[3][4], beta[3];
  for (int row = 0; row < 3; ++row) {
    for (int col = 0; col < 3; ++col) augmented[row][col] = normal[row][col];
    augmented[row][3] = rhs[row];
  }
  if (!solve3x3(augmented, beta)) return false;
  double sst = 0, sse = 0;
  for (size_t i = 0; i < measurement.count; ++i) {
    const double t = (measurement.time[i] - t0) * 1e-6;
    const double angle = TWO_PI * hz * t;
    const double fitted = beta[0] + beta[1] * cos(angle) + beta[2] * sin(angle);
    const double centered = measurement.value[i] - mean;
    const double error = measurement.value[i] - fitted;
    sst += centered * centered; sse += error * error;
  }
  if (sst <= 1e-15) return false;
  r2 = 1.0 - sse / sst;
  rms = sqrt(beta[1] * beta[1] + beta[2] * beta[2]) / sqrt(2.0);
  residualRms = sqrt(sse / measurement.count);
  return isfinite(r2) && isfinite(rms) && isfinite(residualRms);
}
void finishMeasurement() {
  if (measurement.count < 64) {
    measurement.rms = sampleCount ? sqrt(sumSquares / sampleCount) : 0;
    measurement.rate = sampleCount * 1000.0 / max(1UL, millis() - windowStart);
    measurement.state = MEASUREMENT_COMPLETE; measurement.quality = "RAW_WINDOW_FALLBACK"; return;
  }
  const uint64_t t0 = measurement.time[0], t1 = measurement.time[measurement.count - 1];
  if (t1 <= t0) { measurement.state = MEASUREMENT_COMPLETE; measurement.quality = "BAD_TIMESTAMP"; return; }
  measurement.rate = (measurement.count - 1) / ((t1 - t0) * 1e-6);
  double mean = 0;
  for (size_t i = 0; i < measurement.count; ++i) mean += measurement.value[i];
  mean /= measurement.count;
  double totalSquares = 0;
  for (size_t i = 0; i < measurement.count; ++i) {
    const double centered = measurement.value[i] - mean;
    totalSquares += centered * centered;
  }
  measurement.mean = mean;
  measurement.rawAcRms = sqrt(totalSquares / measurement.count);
  if (!fitAtFrequency(measurement.hz, measurement.r2, measurement.rms, measurement.residualRms)) {
    measurement.state = MEASUREMENT_COMPLETE; measurement.quality = "INVALID_FIT"; return;
  }

  // Diagnostic only: search nearby frequencies to reveal drive-frequency
  // mismatch. This estimate never replaces the commanded-frequency fit.
  measurement.bestFitHz = measurement.hz; measurement.bestFitR2 = measurement.r2;
  for (int step = -12; step <= 12; ++step) {
    const double candidate = measurement.hz + step * 0.25;
    if (candidate < MIN_STIMULATION_FREQUENCY_HZ || candidate > MAX_STIMULATION_FREQUENCY_HZ) continue;
    double candidateR2, candidateRms, candidateResidual;
    if (fitAtFrequency(candidate, candidateR2, candidateRms, candidateResidual) && candidateR2 > measurement.bestFitR2) {
      measurement.bestFitHz = candidate; measurement.bestFitR2 = candidateR2;
    }
  }
  measurement.state = MEASUREMENT_COMPLETE;
  if (measurement.rate < MEASUREMENT_MIN_SAMPLES_PER_CYCLE * measurement.hz) measurement.quality = "LOW_SAMPLE_RATE";
  else if (measurement.r2 < .60) measurement.quality = "LOW_FIT_R2";
  else measurement.quality = "MEASURE_OK";
}
void updateMeasurement() { if(measurement.state==MEASUREMENT_SETTLING&&millis()-measurement.startedAt>=MEASUREMENT_SETTLE_MS){measurement.state=MEASUREMENT_CAPTURING;measurement.startedAt=millis();measurement.count=0;measurement.quality="CAPTURING";Serial.println("MEASURE: capturing");}else if(measurement.state==MEASUREMENT_CAPTURING&&millis()-measurement.startedAt>=MEASUREMENT_CAPTURE_MS){prepareMeasurementTimes();finishMeasurement();if (strcmp(measurement.quality,"MEASURE_OK") != 0) measurement.state=MEASUREMENT_INVALID;Serial.printf("MEASURE: %s samples=%u rate=%.1f r2=%.3f rms=%.6f\n",measurement.quality,(unsigned)measurement.count,measurement.rate,measurement.r2,measurement.rms);Serial.printf("FIT_DIAG,axis=%c,target_hz=%.2f,mean_mps2=%.6f,raw_ac_rms_mps2=%.6f,fundamental_rms_mps2=%.6f,residual_rms_mps2=%.6f,r2=%.4f,best_fit_hz=%.2f,best_fit_r2=%.4f\n",MEASUREMENT_AXIS,measurement.hz,measurement.mean,measurement.rawAcRms,measurement.rms,measurement.residualRms,measurement.r2,measurement.bestFitHz,measurement.bestFitR2);} }
uint8_t probeI2C(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission();
}
void resetI2C() {
  Serial.println("I2C: restarting bus before retry");
  Wire.end();
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
  delay(MPU_BOOT_DELAY_MS);
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);
  Wire.setTimeOut(20);
}
bool writeByte(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address); Wire.write(reg); Wire.write(value);
  return Wire.endTransmission() == 0;
}
bool readBytes(uint8_t address, uint8_t reg, uint8_t *buffer, size_t length) {
  Wire.beginTransmission(address); Wire.write(reg);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(address, uint8_t(length)) != length) return false;
  for (size_t i = 0; i < length; ++i) buffer[i] = Wire.read();
  return true;
}
bool configureMpu6050(uint8_t address) {
  // Wake from sleep; ±2 g, 184 Hz DLPF and 250 Hz output (1 kHz / (3 + 1)).
  if (!writeByte(address, 0x6B, 0x01)) return false;
  delay(20);
  return writeByte(address, 0x1A, 0x01) && writeByte(address, 0x19, 0x03) && writeByte(address, 0x1C, 0x00);
}
bool setImuReport(bool enabled) {
  if (!imuFound || !writeByte(mpuAddress, 0x6B, enabled ? 0x01 : 0x40)) return false;
  imuReportEnabled = enabled;
  if (!enabled) { imuReady = false; lastImu = 0; resetWindow(); }
  Serial.printf("MPU6050: accelerometer %s\n", enabled ? "enabled at 250 Hz" : "sleeping");
  return true;
}
bool readMpuAcceleration(float &x, float &y, float &z) {
  uint8_t raw[6];
  if (!readBytes(mpuAddress, 0x3B, raw, sizeof(raw))) return false;
  const float scale = 9.80665f / 16384.0f;
  x = int16_t(uint16_t(raw[0]) << 8 | raw[1]) * scale;
  y = int16_t(uint16_t(raw[2]) << 8 | raw[3]) * scale;
  z = int16_t(uint16_t(raw[4]) << 8 | raw[5]) * scale;
  return isfinite(x) && isfinite(y) && isfinite(z);
}
void retrySensors() {
  // Address probing may block the shared bus and create gaps in a 1.6 s fit.
  if (measurement.state == MEASUREMENT_CAPTURING || measurement.state == MEASUREMENT_SETTLING) return;
  if (imuFound && imuReportEnabled && millis() - (lastImu ? lastImu : imuInitAt) >= SENSOR_RETRY_MS) {
    stopOutput();
    Serial.println("MPU6050: no data for 5 seconds; restarting sensor session");
    imuFound = false; imuReady = false; lastImu = 0;
    mpuNoResponseCycles = 0;
  }
  if (!imuFound) {
    const uint8_t mpuCandidates[] = { MPU6050_ADDRESS_PRIMARY, MPU6050_ADDRESS_ALTERNATE };
    uint8_t timeouts = 0;
    bool response = false;
    for (uint8_t address : mpuCandidates) {
      const uint8_t result = probeI2C(address);
      if (result == 5) { ++timeouts; continue; }
      if (result != 0) continue;
      response = true;
      Serial.printf("MPU6050: 0x%02X responding; initializing\n", address);
      if (configureMpu6050(address)) {
        mpuNoResponseCycles = 0;
        mpuAddress = address; imuFound = true; imuReportEnabled = false; imuReady = false; imuInitAt = millis(); lastImu = 0;
        setImuReport(false);
        Serial.println("MPU6050: initialized; sleeping until sweep preparation");
        break;
      }
      Serial.println("MPU6050: configuration failed; retrying");
      break;
    }
    if (!response) {
      Serial.printf("MPU6050: no response at 0x%02X or 0x%02X (%u timeout(s))\n",
        MPU6050_ADDRESS_PRIMARY, MPU6050_ADDRESS_ALTERNATE, timeouts);
      // A controller restart is justified only when neither device is usable.
      // Restarting it for an isolated MPU6050 failure makes INA226 disappear too.
      if (++mpuNoResponseCycles >= MPU_BUS_RECOVERY_AFTER_MISSES && !inaConfigured) {
        mpuNoResponseCycles = 0;
        Serial.println("MPU6050: repeated address misses; attempting I2C controller recovery");
        resetI2C();
      }
    } else mpuNoResponseCycles = 0;
  }
  if (INA226_PRESENT && !inaConfigured) {
    uint8_t timeouts = 0;
    bool response = false;
    for (uint8_t address = INA_ADDRESS_MIN; address <= INA_ADDRESS_MAX; ++address) {
      const uint8_t result = probeI2C(address);
      if (result == 5) { ++timeouts; continue; }
      if (result != 0) continue;
      response = true;
      uint16_t manufacturer = 0, die = 0;
      if (!readRegister(address, 0xFE, manufacturer) || !readRegister(address, 0xFF, die)) {
        Serial.printf("INA226: 0x%02X responds, but identification read failed\n", address);
      } else if (manufacturer != 0x5449 || (die & 0xFFF0) != 0x2260) {
        Serial.printf("INA226: 0x%02X is not INA226 (manufacturer=0x%04X die=0x%04X)\n", address, manufacturer, die);
      } else if (!writeRegister(address, 0x00, 0x4127)) {
        Serial.printf("INA226: 0x%02X configuration write failed; retrying\n", address);
      } else {
        inaAddress = address; inaConfigured = true;
        Serial.printf("INA226: 0x%02X configured; waiting for readings\n", address);
        break;
      }
    }
    if (!response) Serial.printf("INA226: no response from 0x%02X to 0x%02X (%u timeout(s))\n",
      INA_ADDRESS_MIN, INA_ADDRESS_MAX, timeouts);
  }
}
void handleCommand(const Frame &frame) {
  if (!connected.load() || frame.generation != generation.load()) return;
  JsonDocument cmd;
  if (deserializeJson(cmd, frame.text)) { stopOutput(); return; }
  String id = cmd["commandId"] | "", sid = cmd["sessionId"] | "", kind = cmd["command"] | "";
  if (!id.length() || id.length() > 64 || !sid.length() || sid.length() > 64) { stopOutput(); return; }
  for (unsigned i = 0; i < 8; ++i) if (recentIds[i] == id) {
    JsonDocument cached; deserializeJson(cached, recentAcks[i]); enqueue(cached); return;
  }
  float hz = cmd["frequencyHz"] | -1.0f, level = cmd["intensityPercent"] | -1.0f;
  int duration = cmd["durationSeconds"] | 0;
  String error;
  OutputState before = outputSnapshot();
  if (cmd["protocolVersion"] != 3 || cmd["type"] != "control") error = "Protocol v3 required";
  else if (!isfinite(hz) || hz < MIN_STIMULATION_FREQUENCY_HZ || hz > MAX_STIMULATION_FREQUENCY_HZ || !isfinite(level) || level < 0 || level > 100 ||
    !cmd["durationSeconds"].is<int>() || duration < 1 || duration > 1800) error = "Invalid settings";
  else if (kind == "stop") { stopOutput(); sweeping = false; if (imuReportEnabled) setImuReport(false); }
  else if (kind == "heartbeat") {
    if (!before.active || sid != sessionId) error = "Session inactive";
    else { portENTER_CRITICAL(&outputMux); output.lease = esp_timer_get_time() + LEASE_MS * 1000LL; portEXIT_CRITICAL(&outputMux); }
  } else if (kind == "prepare") {
    if (!imuFound) error = "MPU6050 is offline";
    else if (!setImuReport(true)) error = "MPU6050 setup failed";
    else sweeping = true;
  } else if (kind == "measure") {
    if (!imuReady) error = "MPU6050 must be ready";
    else startMeasurement(hz);
  } else if (kind == "start" || kind == "sweep" || kind == "update") {
    if (!OUTPUT_ENABLED) error = "Output locked: verify amplifier and config.h";
    else if (!imuReady || (INA226_PRESENT && !powerReady)) error = "MPU6050 must be ready";
    else if (kind == "update" && (!before.active || sid != sessionId)) error = "Session inactive";
    else if (kind != "update" && before.active) error = "Stop current session first";
    else {
      sessionId = sid;
      if (kind != "update") sweeping = kind == "sweep";
      int64_t now = esp_timer_get_time();
      portENTER_CRITICAL(&outputMux);
      output.hz = hz; output.level = level; output.active = true;
      if (kind != "update") output.deadline = now + duration * 1000000LL;
      output.lease = now + LEASE_MS * 1000LL;
      portEXIT_CRITICAL(&outputMux);
      resetWindow();
    }
  } else error = "Unknown command";
  JsonDocument ack;
  ack["type"] = "ack"; ack["protocolVersion"] = 3; ack["commandId"] = id; ack["sessionId"] = sid;
  ack["accepted"] = error.isEmpty(); if (!error.isEmpty()) ack["error"] = error;
  recentIds[recentNext] = id; recentAcks[recentNext] = ""; serializeJson(ack, recentAcks[recentNext]);
  recentNext = (recentNext + 1) % 8;
  enqueue(ack);
}
void telemetry() {
  // Keep INA226 observable while idle as well: this is essential for wiring
  // diagnostics and does not enable MPU6050 sampling outside a sweep.
  if (INA226_PRESENT) readPower(); else powerReady = false;
  imuReady = imuFound && lastImu != 0 && millis() - lastImu < 500;
  // Browser Bluetooth audio is independent of INA226. For the optional DAC
  // build, retain the existing fail-safe when either sensor is unavailable.
  if (!imuReady || (OUTPUT_ENABLED && !powerReady)) stopOutput();
  OutputState state = outputSnapshot();
  JsonDocument doc;
  doc["type"] = "telemetry"; doc["protocolVersion"] = 3; doc["bootId"] = bootId;
  doc["sequence"] = sequence++; doc["uptimeMs"] = millis(); doc["sessionId"] = sessionId;
  doc["status"] = state.active ? (sweeping ? "sweeping" : "running") : "idle";
  doc["frequencyHz"] = state.hz; doc["intensityPercent"] = state.level;
  doc["remainingSeconds"] = state.active ? max(0.0, ceil((state.deadline - esp_timer_get_time()) / 1000000.0)) : 0;
  auto imu = doc["imu"].to<JsonObject>(); imu["ready"] = imuReady;
  imu["sampleCount"] = sampleCount;
  imu["sampleRateHz"] = sampleCount * 1000.0 / max(1UL, millis() - windowStart);
  imu["linearAcceleration"] = nullptr; imu["accelerationRms"] = nullptr;
  if (imuReady && sampleCount) {
    auto axes = imu["linearAcceleration"].to<JsonObject>(); axes["x"] = ax; axes["y"] = ay; axes["z"] = az;
    imu["accelerationRms"] = sqrt(sumSquares / sampleCount);
  }
  auto measured = imu["measurement"].to<JsonObject>();
  const char *measurementState = measurement.state == MEASUREMENT_SETTLING ? "settling" : measurement.state == MEASUREMENT_CAPTURING ? "capturing" : measurement.state == MEASUREMENT_COMPLETE ? "complete" : measurement.state == MEASUREMENT_INVALID ? "invalid" : "idle";
  measured["state"] = measurementState;
  if (measurement.state == MEASUREMENT_IDLE) measured["frequencyHz"] = nullptr; else measured["frequencyHz"] = measurement.hz;
  if (measurement.state == MEASUREMENT_COMPLETE) measured["fundamentalAccelerationRms"] = measurement.rms; else measured["fundamentalAccelerationRms"] = nullptr;
  if (isfinite(measurement.r2)) measured["fitR2"] = measurement.r2; else measured["fitR2"] = nullptr;
  measured["quality"] = measurement.quality;
  measured["sampleCount"] = measurement.count; measured["sampleRateHz"] = isfinite(measurement.rate) ? measurement.rate : 0;
  auto power = doc["power"].to<JsonObject>(); power["ready"] = powerReady;
  power["calibrated"] = powerReady && SHUNT_OHMS > 0;
  power["busVoltageV"] = nullptr; power["currentA"] = nullptr; power["powerW"] = nullptr;
  if (powerReady) power["busVoltageV"] = voltage;
  if (powerReady && SHUNT_OHMS > 0) { power["currentA"] = current; power["powerW"] = voltage * current; }
  if (connected.load()) enqueue(doc);
  Serial.printf("IMU=%d rate=%.1f INA=%d V=%.2f output=%d\n", imuReady,
    sampleCount * 1000.0 / max(1UL, millis() - windowStart), powerReady, voltage, state.active);
  resetWindow();
}
void setup() {
  Serial.begin(115200);
  pinMode(25, INPUT);
  rxQueue = xQueueCreate(4, sizeof(Frame)); txQueue = xQueueCreate(4, sizeof(Frame));
  if (!rxQueue || !txQueue) abort();
  if (OUTPUT_ENABLED) { dac_output_enable(DAC_CHANNEL_1); dac_output_voltage(DAC_CHANNEL_1, 128); }
  if (OUTPUT_ENABLED) {
    esp_timer_create_args_t args{}; args.callback = waveTick; args.name = "wave-lease";
    esp_timer_handle_t timer;
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 1000));
  }
  bootId = String((uint32_t)esp_random(), HEX);
  BLEDevice::init("Breath-ESP32");
  auto server = BLEDevice::createServer(); server->setCallbacks(new ServerCallbacks());
  auto service = server->createService(SERVICE);
  notifyChar = service->createCharacteristic(NOTIFY, BLECharacteristic::PROPERTY_NOTIFY);
  notifyChar->addDescriptor(new BLE2902());
  auto control = service->createCharacteristic(CONTROL, BLECharacteristic::PROPERTY_WRITE);
  control->setCallbacks(new ControlCallbacks());
  auto info = service->createCharacteristic(INFO, BLECharacteristic::PROPERTY_READ);
  JsonDocument doc;
  doc["protocolVersion"] = 3; doc["firmwareVersion"] = "3.0.0";
  doc["audioSource"] = "esp32-dac"; doc["outputMode"] = "common"; doc["outputEnabled"] = OUTPUT_ENABLED;
  doc["sensors"]["imu"] = "MPU6050"; doc["sensors"]["power"] = INA226_PRESENT ? "INA226" : "none";
  String value; serializeJson(doc, value); info->setValue(value.c_str());
  service->start(); BLEDevice::getAdvertising()->addServiceUUID(SERVICE);
  BLEDevice::getAdvertising()->setScanResponse(true); BLEDevice::startAdvertising();
  if (xTaskCreate(transmit, "ble-tx", 4096, nullptr, 1, nullptr) != pdPASS) abort();
  resetWindow();
  Serial.printf("BLE ready, OUTPUT_ENABLED=%d. No automatic start.\n", OUTPUT_ENABLED);
  // Diagnose the shared sensor bus at 100 kHz before considering a faster bus.
  Wire.begin(SDA_PIN, SCL_PIN); Wire.setClock(100000); Wire.setTimeOut(20);
  Serial.printf("I2C: SDA=%d SCL=%d; MPU6050=0x%02X/0x%02X INA226=0x%02X..0x%02X; 100 kHz diagnostic\n",
    SDA_PIN, SCL_PIN, MPU6050_ADDRESS_PRIMARY, MPU6050_ADDRESS_ALTERNATE, INA_ADDRESS_MIN, INA_ADDRESS_MAX);
  Serial.printf("MPU6050: waiting %lu ms for power-on stabilization\n", SENSOR_COLD_STARTUP_DELAY_MS);
  delay(SENSOR_COLD_STARTUP_DELAY_MS);
  resetI2C();
  retrySensors();
  lastSensorRetry = millis();
}
void loop() {
  if (advertiseAgain.exchange(false)) BLEDevice::startAdvertising();
  if (seenGeneration != generation.load()) {
    seenGeneration = generation.load();
    for (unsigned i = 0; i < 8; ++i) { recentIds[i] = ""; recentAcks[i] = ""; }
  }
  Frame frame;
  if (xQueueReceive(rxQueue, &frame, 0) == pdTRUE) handleCommand(frame);
  // Retry a missing MPU6050 sooner, but do not block an ongoing frequency
  // capture with I2C scanning/reinitialization.
  const uint32_t retryInterval = imuFound ? SENSOR_RETRY_MS : MPU_OFFLINE_RETRY_MS;
  if (millis() - lastSensorRetry >= retryInterval) {
    lastSensorRetry = millis();
    retrySensors();
  }
  if (imuFound && imuReportEnabled && millis() - lastMpuReadAt >= IMU_SAMPLE_INTERVAL_MS) {
    lastMpuReadAt = millis();
    if (!readMpuAcceleration(ax, ay, az)) {
      imuReady = false;
    } else {
      sumSquares += double(ax)*ax + double(ay)*ay + double(az)*az;
      sampleCount++; lastImu = millis(); imuReady = true;
      if (measurement.state == MEASUREMENT_CAPTURING && measurement.count < MEASUREMENT_MAX_SAMPLES) {
        const uint64_t stamp = esp_timer_get_time();
        measurement.sensorTime[measurement.count] = stamp;
        measurement.time[measurement.count] = stamp;
        measurement.value[measurement.count++] = MEASUREMENT_AXIS == 'X' ? ax : MEASUREMENT_AXIS == 'Y' ? ay : az;
      }
    }
  }
  updateMeasurement();
  // The expanded telemetry frame is fragmented into 20-byte notifications.
  // A one-second interval leaves transport headroom for loss-free delivery.
  if (millis() - windowStart >= 1000) telemetry();
  delay(1);
}
