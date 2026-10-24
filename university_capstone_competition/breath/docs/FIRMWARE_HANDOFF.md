# 펌웨어 작업 안내 — v3

팀원은 BNO085/INA226을 연결하고 ESP32 테스트 코드를 실행한 상태입니다.
기존 테스트 .ino와 라이브러리 버전, 주소/핀, 실제 값 로그를 보관한 뒤 통합 펌웨어를 올리세요.

## 파일과 도구

Arduino IDE에서 firmware/esp32_ble/breath_esp32/breath_esp32.ino를 엽니다.
같은 폴더의 config.h가 함께 필요합니다.
보드 매니저: esp32 by Espressif Systems **2.0.17**, 보드 ESP32 Dev Module.
라이브러리: Adafruit BNO08x **1.2.5**, ArduinoJson **7.2.1**, BNO08x의 의존 라이브러리도 설치.
PlatformIO 대안은 firmware/esp32_ble에서 pio run (platformio.ini의 버전 고정).
S3/C3 등 다른 ESP32 변종에 그대로 업로드하지 않습니다.

## 현재 설정

- SDA21, SCL22, BNO085 RST5, INT4. 실제 배선과 대조합니다.
- Adafruit I²C 라이브러리는 폴링합니다. INT4는 입력으로만 설정합니다.
- BNO 주소 0x4A. 팀 테스트가 0x4B이면 config.h에서 수정합니다.
- INA 주소 0x40. 제조사/칩 ID를 확인하며 버스전압/션트전압을 읽습니다.
- SHUNT_OHMS=0: 전류/전력 미보정. 모듈 실제 저항값 확인 전 추측해 입력하지 않습니다.
- OUTPUT_ENABLED=false: 센서/BLE부터 검사.
- DAC 후보: GPIO25, 1ms 소프트웨어 타이머 사인파. PWM 드라이버 지원이 아닙니다.
- MAX_DAC_AMPLITUDE=24는 DAC 코드 제한이며 힘/전압 안전을 보장하지 않습니다.

## 반드시 남아 있는 검증

앰프가 DC 바이어스된 아날로그 신호를 받을 수 있는지, AC 결합이 필요한지,
입력 범위/접지/전원/진동자 임피던스·정격을 부품 문서와 실물로 확인해야 합니다.
회로도 그림의 선 색이나 핀 위치만 보고 배선하지 마세요.
앰프 출력의 -단자를 임의로 공통 GND에 연결하지 마세요.
오실로스코프로 무부하 신호 주파수/진폭/정지 상태를 확인하세요.
BNO085 I²C의 실제 안정성/샘플링률을 확인하고 200Hz 미만이면 스윕을 강제로 통과시키지 마세요.
정지/브라우저 닫기/BLE 끄기/시간 만료/센서 분리(전원 차단 후 작업)를 시험합니다.
센서 I²C가 멈춰도 별도 타이머의 유지 신호 제한이 작동하는지 실물 확인이 필요합니다.
처음에는 사람 몸에 부착하지 말고 테스트 지그에서 진행합니다.

## 공식 참고 자료

- [ESP32 DAC](https://docs.espressif.com/projects/esp-idf/en/v4.4.8/esp32/api-reference/peripherals/dac.html)
- [BNO08x 라이브러리](https://github.com/adafruit/Adafruit_BNO08x)
- [INA226 데이터시트](https://www.ti.com/lit/ds/symlink/ina226.pdf)
- [Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth)

