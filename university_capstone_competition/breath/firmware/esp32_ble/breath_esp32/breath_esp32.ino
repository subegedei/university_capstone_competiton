// Classic ESP32 / Arduino-ESP32 2.0.17. See config.h before wiring.
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BNO08x.h>
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
Adafruit_BNO08x bno(BNO_RST_PIN);
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
bool inaConfigured = false;
uint8_t bnoAddress = 0, inaAddress = 0;
uint8_t imuInitFailures = 0;
uint32_t lastSensorRetry = 0, imuInitAt = 0;
constexpr uint32_t SENSOR_RETRY_MS = 5000;
String sessionId, bootId, recentIds[8], recentAcks[8];
unsigned recentNext = 0;
uint32_t sequence = 0, lastImu = 0, windowStart = 0, sampleCount = 0, seenGeneration = 0;
double sumSquares = 0;
float ax = 0, ay = 0, az = 0, voltage = 0, current = 0;

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
      vTaskDelay(pdMS_TO_TICKS(5));
    }
  }
}
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { stopOutput(); generation++; connected = true; }
  void onDisconnect(BLEServer *) override { connected = false; generation++; stopOutput(); advertiseAgain = true; }
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
  uint16_t bus, shunt, manufacturer, die;
  powerReady = inaConfigured && inaAddress && readRegister(inaAddress, 0xFE, manufacturer) && manufacturer == 0x5449 &&
    readRegister(inaAddress, 0xFF, die) && (die & 0xFFF0) == 0x2260 &&
    readRegister(inaAddress, 0x02, bus) && readRegister(inaAddress, 0x01, shunt);
  if (powerReady) {
    voltage = bus * 0.00125f;
    current = SHUNT_OHMS > 0 ? int16_t(shunt) * 0.0000025f / SHUNT_OHMS : 0;
  } else if (inaConfigured) {
    inaConfigured = false; inaAddress = 0;
    Serial.println("INA226: read failed; will retry configuration");
  }
}
void resetWindow() { sumSquares = 0; sampleCount = 0; windowStart = millis(); }
uint8_t probeI2C(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission();
}
void retrySensors() {
  if (imuFound && millis() - (lastImu ? lastImu : imuInitAt) >= SENSOR_RETRY_MS) {
    stopOutput();
    Serial.println("BNO085: no data for 5 seconds; restarting sensor session");
    imuFound = false; imuReady = false; lastImu = 0;
    sh2_close();
  }
  if (!imuFound) {
    const uint8_t bnoCandidates[] = { BNO_ADDRESS_PRIMARY, BNO_ADDRESS_ALTERNATE };
    uint8_t timeouts = 0;
    bool response = false;
    for (uint8_t address : bnoCandidates) {
      const uint8_t result = probeI2C(address);
      if (result == 5) { ++timeouts; continue; }
      if (result != 0) continue;
      response = true;
      if (imuInitFailures >= 3) { Serial.println("BNO085: initialization failed 3 times; reset ESP32 to retry"); break; }
      Serial.printf("BNO085: 0x%02X responding; initializing\n", address);
      const bool initialized = bno.begin_I2C(address, &Wire);
      if (initialized && bno.enableReport(SH2_LINEAR_ACCELERATION, 4000)) {
        bnoAddress = address; imuFound = true; imuInitFailures = 0; imuInitAt = millis(); lastImu = 0;
        Serial.println("BNO085: initialized; waiting for acceleration data");
        break;
      }
      ++imuInitFailures;
      Serial.println("BNO085: initialization or acceleration report setup failed; retrying");
      if (initialized) sh2_close();
    }
    if (!response) Serial.printf("BNO085: no response at 0x%02X or 0x%02X (%u timeout(s))\n",
      BNO_ADDRESS_PRIMARY, BNO_ADDRESS_ALTERNATE, timeouts);
  }
  if (!inaConfigured) {
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
  else if (!isfinite(hz) || hz < 15 || hz > 50 || !isfinite(level) || level < 0 || level > 100 ||
    !cmd["durationSeconds"].is<int>() || duration < 1 || duration > 1800) error = "Invalid settings";
  else if (kind == "stop") { stopOutput(); sweeping = false; }
  else if (kind == "heartbeat") {
    if (!before.active || sid != sessionId) error = "Session inactive";
    else { portENTER_CRITICAL(&outputMux); output.lease = esp_timer_get_time() + LEASE_MS * 1000LL; portEXIT_CRITICAL(&outputMux); }
  } else if (kind == "start" || kind == "sweep" || kind == "update") {
    if (!OUTPUT_ENABLED) error = "Output locked: verify amplifier and config.h";
    else if (!imuReady || !powerReady) error = "BNO085 and INA226 must be ready";
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
  readPower();
  imuReady = imuFound && lastImu != 0 && millis() - lastImu < 500;
  if (!imuReady || !powerReady) stopOutput();
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
  pinMode(BNO_INT_PIN, INPUT_PULLUP); // Adafruit I2C transport polls, no ISR.
  pinMode(25, INPUT);
  rxQueue = xQueueCreate(4, sizeof(Frame)); txQueue = xQueueCreate(4, sizeof(Frame));
  if (!rxQueue || !txQueue) abort();
  if (OUTPUT_ENABLED) { dac_output_enable(DAC_CHANNEL_1); dac_output_voltage(DAC_CHANNEL_1, 128); }
  esp_timer_create_args_t args{}; args.callback = waveTick; args.name = "wave-lease";
  esp_timer_handle_t timer;
  ESP_ERROR_CHECK(esp_timer_create(&args, &timer));
  ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 1000));
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
  doc["sensors"]["imu"] = "BNO085"; doc["sensors"]["power"] = "INA226";
  String value; serializeJson(doc, value); info->setValue(value.c_str());
  service->start(); BLEDevice::getAdvertising()->addServiceUUID(SERVICE);
  BLEDevice::getAdvertising()->setScanResponse(true); BLEDevice::startAdvertising();
  if (xTaskCreate(transmit, "ble-tx", 4096, nullptr, 1, nullptr) != pdPASS) abort();
  resetWindow();
  Serial.printf("BLE ready, OUTPUT_ENABLED=%d. No automatic start.\n", OUTPUT_ENABLED);
  // Diagnose the shared sensor bus at 100 kHz before considering a faster bus.
  Wire.begin(SDA_PIN, SCL_PIN); Wire.setClock(100000); Wire.setTimeOut(20);
  Serial.printf("I2C: SDA=%d SCL=%d; BNO085=0x%02X/0x%02X INA226=0x%02X..0x%02X; 100 kHz diagnostic; retry every 5 seconds\n",
    SDA_PIN, SCL_PIN, BNO_ADDRESS_PRIMARY, BNO_ADDRESS_ALTERNATE, INA_ADDRESS_MIN, INA_ADDRESS_MAX);
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
  if (millis() - lastSensorRetry >= SENSOR_RETRY_MS) {
    lastSensorRetry = millis();
    retrySensors();
  }
  if (imuFound) {
    if (bno.wasReset()) {
      stopOutput(); lastImu = 0; imuInitAt = millis(); resetWindow();
      if (!bno.enableReport(SH2_LINEAR_ACCELERATION, 4000)) {
        Serial.println("BNO085: report setup after reset failed; retrying");
        imuFound = false; imuReady = false; sh2_close();
      }
    }
    sh2_SensorValue_t event;
    if (imuFound && bno.getSensorEvent(&event) && event.sensorId == SH2_LINEAR_ACCELERATION) {
      ax = event.un.linearAcceleration.x; ay = event.un.linearAcceleration.y; az = event.un.linearAcceleration.z;
      if (isfinite(ax) && isfinite(ay) && isfinite(az)) {
        sumSquares += double(ax)*ax + double(ay)*ay + double(az)*az;
        sampleCount++; lastImu = millis(); imuReady = true;
      }
    }
  }
  if (millis() - windowStart >= 250) telemetry();
  delay(1);
}
