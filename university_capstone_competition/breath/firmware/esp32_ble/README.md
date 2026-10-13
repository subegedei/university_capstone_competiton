# ESP32 firmware starter

This starter targets an original ESP32 DevKit with its internal DAC on GPIO25
connected to the ZK-502C AUX input. It uses the Arduino framework.

Install these libraries in Arduino IDE or PlatformIO:

- ArduinoJson 7
- Adafruit LSM6DSOX
- Adafruit Unified Sensor

Before uploading, set the I2C and piezo pins in `src/main.cpp`. The same UUIDs
must remain in the web app and firmware.
