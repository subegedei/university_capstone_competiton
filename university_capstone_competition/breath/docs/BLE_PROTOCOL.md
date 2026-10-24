# BLE 통신 규약 v3

v2(browser-bluetooth) 및 기존 LSM6DSOX 펌웨어와 호환되지 않습니다.
정확한 JSON 예시는 protocol-fixtures.json, 형식 검증은 lib/ble/protocol.ts입니다.

## 특성

- 서비스: f3f1a000-7c5b-4f18-b0bb-7d9cb9d00001
- Notify: f3f1a001-7c5b-4f18-b0bb-7d9cb9d00001 (CCCD 구독)
- Control: f3f1a002-7c5b-4f18-b0bb-7d9cb9d00001 (Write with response)
- Info: f3f1a003-7c5b-4f18-b0bb-7d9cb9d00001 (Read, 완전한 JSON)

Info의 protocolVersion=3, audioSource="esp32-dac", outputMode="common",
sensors={imu:"BNO085",power:"INA226"}, outputEnabled:boolean이 필수입니다.
outputEnabled는 설정 허용 여부이지 전기적 안전 인증이 아닙니다.

## 프레임과 명령

Control/Notify는 UTF-8 NDJSON(마지막 LF), ATT 청크 최대 20바이트.
한 청크가 JSON 한 개라는 가정은 금지합니다. Notify의 ACK와 telemetry는 직렬로 전송합니다.
명령은 type, protocolVersion, commandId, sessionId, command, frequencyHz, intensityPercent, durationSeconds를 포함합니다.
주파수 15–50Hz, 레벨 0–100%, 시간 정수 1–1800초.
start/sweep는 새로운 세션을 시작, update는 같은 세션에서 주파수·레벨만 변경하며 종료 시각은 유지합니다.
stop은 현재 출력을 정지합니다. 재연결하면 자동 시작하지 않습니다.
heartbeat는 같은 활성 세션의 유지 신호입니다. 설정/종료 시각을 바꾸지 않습니다.
웹은 작동 중 약 1초마다 heartbeat를 보내고, 펌웨어는 5초간 갱신이 없으면 파형을 정지합니다.
ACK를 5초 안에 받지 못하면 웹은 연결을 해제합니다. 웹 센서 수신 제한은 4초입니다.
ACK는 같은 commandId/sessionId와 accepted를 포함하며 거절에는 error 문자열을 보냅니다.
펌웨어는 최근 8개 commandId의 ACK를 기억하여 중복 명령을 재실행하지 않습니다.

## 센서 데이터

약 250ms 윈도우. 선형 가속도 단위 m/s², RMS는 sqrt(mean(x²+y²+z²)).
sampleRateHz는 실제 수집 개수/윈도우 경과 시간입니다. 요청 주기 4000us가 실제 250Hz를 보장하지 않습니다.
스윕은 최소 200Hz, 안정화 후 주파수당 2개 이상 윈도우를 요구합니다.
INA226 버스전압 V, 전류 A, 전력 W. SHUNT_OHMS 확인 전 currentA/powerW=null.
전류는 shuntVoltage/확인한저항값으로 환산하며 실측 계기와 비교 보정이 필요합니다.
누락값은 0이 아닌 null입니다. bootId 변경은 재부팅으로 처리하며 중복 sequence는 무시합니다.

## 정지 한계

펌웨어 타이머에서 연결/시간/유지 신호를 확인하고, 센서 또는 큐 오류에서도 파형을 정지합니다.
OUTPUT_ENABLED=false이면 GPIO25 DAC는 활성화하지 않습니다.
true일 때 정지는 DAC 코드 128(약 1.65V 바이어스)으로 복귀하는 것입니다.
전원 차단, 무전압, 전류 제한 또는 하드웨어 비상정지를 의미하지 않습니다.
AC 결합을 포함한 입력 회로 검토 및 물리적인 전원 차단 수단이 필수입니다.

