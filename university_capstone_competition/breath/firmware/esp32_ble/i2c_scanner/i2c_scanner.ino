// Minimal ESP32 I2C diagnostic.
// This sketch intentionally has NO BLE, BNO085, INA226, or audio code.
// It only checks whether anything answers on GPIO21 (SDA) / GPIO22 (SCL).

#include <Wire.h>

constexpr int SDA_PIN = 21;
constexpr int SCL_PIN = 22;
constexpr uint32_t I2C_CLOCK_HZ = 100000; // conservative diagnostic speed

void scanBus() {
  uint8_t found = 0;
  uint8_t errors = 0;

  Serial.println("\nI2C scan: GPIO21=SDA, GPIO22=SCL, 100 kHz");
  for (uint8_t address = 1; address < 127; ++address) {
    Wire.beginTransmission(address);
    const uint8_t result = Wire.endTransmission();
    if (result == 0) {
      Serial.printf("  found: 0x%02X\n", address);
      ++found;
    } else if (result == 5) {
      // ESP32 reports 5 for a bus timeout. Print only the summary so the
      // serial monitor remains readable when a line is held or disconnected.
      ++errors;
    }
  }

  if (found == 0) Serial.println("  no I2C addresses found");
  Serial.printf("scan complete: %u address(es), %u timeout(s)\n", found, errors);
  Serial.println("Expected when wired correctly: BNO085 0x4B, INA226 0x40");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(I2C_CLOCK_HZ);
  Wire.setTimeOut(20);
  Serial.println("ESP32 minimal I2C scanner started");
  scanBus();
}

void loop() {
  delay(5000);
  scanBus();
}
