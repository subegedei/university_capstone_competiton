#pragma once
// ZK-502C receives audio over Bluetooth; GPIO25 DAC is not wired to its AUX input.
constexpr bool OUTPUT_ENABLED = false;
// ESP32 DEVKIT V1 default I2C wiring: SDA -> GPIO21, SCL -> GPIO22.
constexpr int SDA_PIN = 21, SCL_PIN = 22;
// MPU6050 uses I2C only. AD0 selects 0x68 (GND) or 0x69 (VCC); try both.
constexpr uint8_t MPU6050_ADDRESS_PRIMARY = 0x68, MPU6050_ADDRESS_ALTERNATE = 0x69;
// INA226 address straps select an address from this range. The firmware checks
// every address and accepts one only after its manufacturer/device IDs match.
constexpr uint8_t INA_ADDRESS_MIN = 0x40, INA_ADDRESS_MAX = 0x4F;
// INA226 board shunt marked R100 = 0.100 ohm (100 milliohm).
constexpr float SHUNT_OHMS = 0.100f;
// DAC codes, not a validated safe force. Idle code 128 is DC bias.
constexpr int MAX_DAC_AMPLITUDE = 24;
constexpr int LEASE_MS = 5000;
// Hardware protection: this prototype must never drive at or above 45 Hz.
constexpr float MIN_STIMULATION_FREQUENCY_HZ = 25.0f;
constexpr float MAX_STIMULATION_FREQUENCY_HZ = 40.0f;
