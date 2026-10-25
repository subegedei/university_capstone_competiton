#pragma once
// ZK-502C receives audio over Bluetooth; GPIO25 DAC is not wired to its AUX input.
constexpr bool OUTPUT_ENABLED = false;
constexpr int SDA_PIN = 21, SCL_PIN = 22;
constexpr int BNO_RST_PIN = 5, BNO_INT_PIN = 4;
constexpr uint8_t BNO_ADDRESS = 0x4B, INA_ADDRESS = 0x40;
// INA226 board shunt marked R010 = 0.010 ohm (10 milliohm).
constexpr float SHUNT_OHMS = 0.010f;
// DAC codes, not a validated safe force. Idle code 128 is DC bias.
constexpr int MAX_DAC_AMPLITUDE = 24;
constexpr int LEASE_MS = 5000;
