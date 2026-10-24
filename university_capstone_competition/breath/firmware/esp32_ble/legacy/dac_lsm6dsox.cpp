// ARCHIVED v1 example: DAC + LSM6DSOX + piezo. NOT for the BNO085/INA226 Bluetooth-audio design.
#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <ArduinoJson.h>
#include <Adafruit_LSM6DSOX.h>

// Must match docs/BLE_PROTOCOL.md and lib/ble/protocol.ts.
static const char *SERVICE_UUID = "f3f1a000-7c5b-4f18-b0bb-7d9cb9d00001";
static const char *TELEMETRY_UUID = "f3f1a001-7c5b-4f18-b0bb-7d9cb9d00001";
static const char *CONTROL_UUID = "f3f1a002-7c5b-4f18-b0bb-7d9cb9d00001";

constexpr uint8_t DAC_AUDIO_PIN = 25;   // ESP32 classic internal DAC1
constexpr uint8_t PIEZO_PIN = 34;       // Change to the actual ADC wiring pin
constexpr uint8_t I2C_SDA_PIN = 21;
constexpr uint8_t I2C_SCL_PIN = 22;
constexpr uint32_t SAMPLE_INTERVAL_US = 1000; // 1 kHz waveform sample rate
constexpr float MIN_HZ = 15.0f;
constexpr float MAX_HZ = 50.0f;

Adafruit_LSM6DSOX lsm6ds;
BLECharacteristic *telemetryCharacteristic;
bool deviceConnected = false;
bool lsmReady = false;
bool running = false;
float targetHz = 30.0f;
uint8_t intensityPercent = 50;
uint32_t stopAtMs = 0;
uint32_t lastWaveSampleUs = 0;
uint32_t lastTelemetryMs = 0;
float phase = 0.0f;

struct ChannelReading { float accelerationRms; int piezoRaw; float piezoRms; };
ChannelReading channel1 = {0.0f, 0, 0.0f};

void stopVibration() {
  running = false;
  dacWrite(DAC_AUDIO_PIN, 128); // Neutral bias; the amplifier receives no AC component.
}

void applyControl(JsonDocument &doc) {
  const char *command = doc["command"] | "";
  if (doc["frequencyHz"].is<float>()) targetHz = constrain(doc["frequencyHz"].as<float>(), MIN_HZ, MAX_HZ);
  if (doc["intensityPercent"].is<int>()) intensityPercent = constrain(doc["intensityPercent"].as<int>(), 0, 100);
  const uint32_t durationSeconds = constrain(doc["durationSeconds"] | 0, 0, 1800);

  if (!strcmp(command, "stop")) {
    stopVibration();
  } else if (!strcmp(command, "start")) {
    running = true;
    stopAtMs = durationSeconds ? millis() + durationSeconds * 1000UL : 0;
  }
  // "update" changes the pending/current settings; "sweep" is implemented later
  // as a sequence of controlled start/update commands from the browser.
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { deviceConnected = true; }
  void onDisconnect(BLEServer *server) override {
    deviceConnected = false;
    stopVibration(); // Mandatory device-side fail-safe on BLE loss.
    server->startAdvertising();
  }
};

class ControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    const std::string value = characteristic->getValue();
    JsonDocument doc;
    if (deserializeJson(doc, value) || strcmp(doc["type"] | "", "control")) return;
    applyControl(doc);
  }
};

void updateWaveform() {
  if (!running) return;
  if (stopAtMs && millis() >= stopAtMs) { stopVibration(); return; }
  const uint32_t now = micros();
  if (now - lastWaveSampleUs < SAMPLE_INTERVAL_US) return;
  lastWaveSampleUs = now;
  phase += 2.0f * PI * targetHz / (1000000.0f / SAMPLE_INTERVAL_US);
  if (phase >= 2.0f * PI) phase -= 2.0f * PI;
  const float amplitude = 127.0f * intensityPercent / 100.0f;
  dacWrite(DAC_AUDIO_PIN, (uint8_t)(128.0f + sinf(phase) * amplitude));
}

void readSensors() {
  channel1.piezoRaw = analogRead(PIEZO_PIN);
  channel1.piezoRms = abs(channel1.piezoRaw - 2048) / 2048.0f;
  if (!lsmReady) return;
  sensors_event_t accel, gyro, temp;
  lsm6ds.getEvent(&accel, &gyro, &temp);
  channel1.accelerationRms = sqrtf(accel.acceleration.x * accel.acceleration.x + accel.acceleration.y * accel.acceleration.y + accel.acceleration.z * accel.acceleration.z);
}

void sendTelemetry() {
  if (!deviceConnected || millis() - lastTelemetryMs < 200) return; // 5 Hz
  lastTelemetryMs = millis();
  readSensors();
  StaticJsonDocument<384> doc;
  doc["type"] = "telemetry";
  doc["timestampMs"] = millis();
  doc["status"] = running ? "running" : "idle";
  doc["frequencyHz"] = targetHz;
  doc["intensityPercent"] = intensityPercent;
  doc["remainingSeconds"] = stopAtMs && running ? (stopAtMs - millis()) / 1000UL : 0;
  JsonObject channel = doc["channels"].to<JsonArray>().add<JsonObject>();
  channel["id"] = 1;
  channel["accelerationRms"] = channel1.accelerationRms;
  channel["piezoRaw"] = channel1.piezoRaw;
  channel["piezoRms"] = channel1.piezoRms;
  char output[384];
  size_t length = serializeJson(doc, output, sizeof(output));
  telemetryCharacteristic->setValue((uint8_t *)output, length);
  telemetryCharacteristic->notify();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIEZO_PIN, INPUT);
  dacWrite(DAC_AUDIO_PIN, 128);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  lsmReady = lsm6ds.begin_I2C();

  BLEDevice::init("BreathTokTok-ESP32");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *service = server->createService(SERVICE_UUID);
  telemetryCharacteristic = service->createCharacteristic(TELEMETRY_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  BLECharacteristic *control = service->createCharacteristic(CONTROL_UUID, BLECharacteristic::PROPERTY_WRITE);
  control->setCallbacks(new ControlCallbacks());
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->start();
}

void loop() { updateWaveform(); sendTelemetry(); }
