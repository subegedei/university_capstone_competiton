#pragma once
// ZK-502C receives audio over Bluetooth; GPIO25 DAC is not wired to its AUX input.
constexpr bool OUTPUT_ENABLED = false;
constexpr int SDA_PIN = 21, SCL_PIN = 22;
constexpr int BNO_RST_PIN = 5, BNO_INT_PIN = 4;
// BNO085 supports these two I2C addresses. The firmware tries both.
constexpr uint8_t BNO_ADDRESS_PRIMARY = 0x4B, BNO_ADDRESS_ALTERNATE = 0x4A;
// INA226 address straps select an address from this range. The firmware checks
// every address and accepts one only after its manufacturer/device IDs match.
constexpr uint8_t INA_ADDRESS_MIN = 0x40, INA_ADDRESS_MAX = 0x4F;
// INA226 board shunt marked R100 = 0.100 ohm (100 milliohm).
constexpr float SHUNT_OHMS = 0.100f;
// DAC codes, not a validated safe force. Idle code 128 is DC bias.
constexpr int MAX_DAC_AMPLITUDE = 24;
constexpr int LEASE_MS = 5000;
