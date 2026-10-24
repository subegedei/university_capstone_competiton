#pragma once
// Enable ONLY after verifying an AC-coupled analog amplifier input.
// Not for PWM-only motor drivers. Default: sensor/BLE tests only.
constexpr bool OUTPUT_ENABLED = false;
constexpr int SDA_PIN = 21, SCL_PIN = 22;
constexpr int BNO_RST_PIN = 5, BNO_INT_PIN = 4;
constexpr uint8_t BNO_ADDRESS = 0x4A, INA_ADDRESS = 0x40;
// VERIFIED shunt resistance in ohms. 0 = current/power unavailable.
constexpr float SHUNT_OHMS = 0.0f;
// DAC codes, not a validated safe force. Idle code 128 is DC bias.
constexpr int MAX_DAC_AMPLITUDE = 24;
constexpr int LEASE_MS = 5000;
