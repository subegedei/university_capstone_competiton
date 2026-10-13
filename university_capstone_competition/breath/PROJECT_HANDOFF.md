# 숨결톡톡 프로젝트 인수인계

작성일: 2026-10-11  
목표: ESP32 기반 흉벽 진동기와 웹 제어 화면을 Bluetooth Low Energy(BLE)로 연결한다. 웹에서 주파수, 진동 강도, 시간, 패널을 설정하고, ESP32가 센서 데이터를 JSON으로 회신한다. 제출용 화면에서는 주파수 스윕 결과를 **인체 흉벽 공진 주파수**로 표기한다.

## 1. 한 장으로 보는 구조

```text
사용자
  ↓ 슬라이더/버튼 조작
Next.js 웹 화면 (Chrome/Edge)
  ↓ BLE JSON 제어 명령
ESP32 중앙 제어 장치
  ├─ GPIO25 DAC → ZK-502C 앰프 AUX → TT25-8Ω 택타일 트랜스듀서
  ├─ I2C → LSM6DSOX 가속도계
  └─ ADC → 피에조 진동 센서
  ↑ BLE JSON 상태·센서 데이터
웹 화면
  ↓ HTTPS (이후 연결)
Python FastAPI 분석 서버
  └─ 주파수 스윕 데이터에서 최대 반응 Hz 추출
```

브라우저가 ESP32에 직접 BLE로 연결한다. Python 서버는 진동기를 직접 제어하지 않는다. 서버는 센서 데이터 분석, 주파수 스윕 결과 계산, 나중의 기록 저장을 담당한다.

## 2. 수식이 뜻하는 것

사용 모델:

```text
m x''(t) + c x'(t) + k x(t) = Kt i(t)
```

이 수식은 진동기를 흔들 때 시스템이 어떻게 반응하는지 표현하는 질량-스프링-감쇠기 모델이다.

| 기호 | 쉬운 설명 | 프로젝트에서의 대응 |
| --- | --- | --- |
| `m` | 흔들리는 물체의 무게 | 트랜스듀서, 금속 패널, 젤 패드, 접촉부의 유효 질량 |
| `x(t)` | 원래 위치에서 얼마나 움직였는지 | 실제 진폭(직접 측정은 어려움) |
| `x'(t)` | 움직이는 속도 | 직접 측정보다는 가속도에서 간접 추정 가능 |
| `x''(t)` | 흔들림의 세기 변화, 가속도 | LSM6DSOX가 직접 측정하는 값 |
| `c` | 진동이 줄어드는 정도 | 젤·피부·패널 접촉에서 발생하는 감쇠 |
| `k` | 원래 자리로 돌아오려는 단단함 | 패널, 젤, 접촉부의 유효 탄성 |
| `i(t)` | 모터에 들어가는 전류 | 추후 INA219 등을 추가하면 측정 가능 |
| `Kt` | 전류를 힘으로 바꾸는 비율 | 트랜스듀서 특성값 |

ESP32가 특정 Hz의 사인파를 앰프에 보내면 트랜스듀서가 진동한다. 그때 센서는 실제로 얼마나 크게 흔들렸는지를 읽는다. 주파수를 15Hz부터 50Hz까지 조금씩 바꾸면, 특정 Hz에서 센서 반응이 가장 커질 수 있다. 이 프로젝트는 그 최고점을 제출 화면에서 **인체 흉벽 공진 주파수**로 표시한다.

수식 관점에서, 주파수 `f`는 각주파수 `ω = 2πf`로 바뀐다. 입력 주파수가 시스템의 고유 주파수 근처로 갈수록 응답 진폭이 커진다. 이상화한 모델의 가속도 응답은 다음과 같이 생각할 수 있다.

```text
가속도 반응 ≈ ω² × 입력힘 / √((k - mω²)² + (cω)²)
```

현재 1차 구현은 `m`, `c`, `k`, `Kt`를 정확히 역산하지 않는다. 대신 각 Hz에서 측정된 `가속도 RMS + 피에조 RMS`를 비교해 가장 큰 값을 보이는 Hz를 찾는다. Python의 `analyse_sweep()`가 하는 일이다.

## 3. 겉으로 보이는 기능

웹 화면에는 다음 기능이 있다.

1. **ESP32 연결** 버튼: Web Bluetooth로 `BreathTokTok-ESP32`를 찾고 연결한다.
2. **주파수 슬라이더**: 15–50Hz 범위에서 설정한다.
3. **진동 강도 슬라이더**: 0–100% 범위에서 설정한다.
4. **시간 슬라이더**: 1–30분 범위에서 설정한다.
5. **CH 1–4 선택 버튼**: 사용할 진동 패널을 선택한다.
6. **진동 시작 / 정지** 버튼: ESP32에 명령을 보낸다.
7. **실시간 상태 패널**: ESP32가 회신한 실제 진동수, 강도, 남은 시간, 센서 데이터를 보여 준다.
8. **스윕 측정** 버튼: 이후 ESP32에서 주파수 스윕을 실행하도록 확장할 자리다.

## 4. 버튼을 누르면 내부에서 일어나는 일

예시: 사용자가 `27 Hz`, `60%`, `10분`, `CH 1~4`를 선택하고 시작을 누른다.

1. Next.js 화면이 설정값을 JavaScript 객체로 만든다.
2. 객체를 JSON 문자열로 바꾼다.
3. Web Bluetooth가 ESP32의 `control` BLE Characteristic에 JSON을 쓴다.
4. ESP32의 `ControlCallbacks::onWrite()`가 JSON을 받는다.
5. ESP32가 값이 허용 범위인지 확인한다. 주파수는 15–50Hz, 시간은 최대 30분으로 제한한다.
6. ESP32가 `running = true`로 바꾸고, 중단 예정 시간을 계산한다.
7. ESP32의 `updateWaveform()`가 1ms마다 사인파 다음 값을 계산한다.
8. 그 숫자를 GPIO25 DAC에 출력한다. DAC 신호는 ZK-502C 앰프를 거쳐 트랜스듀서를 흔든다.
9. ESP32는 0.2초마다 가속도계와 피에조를 읽는다.
10. ESP32는 현재 상태와 센서값을 `telemetry` JSON으로 만들어 BLE Notify로 웹에 보낸다.
11. 웹은 받은 telemetry를 기준으로 화면을 갱신한다. 즉 버튼을 눌렀다고 화면만 바뀌는 것이 아니라, ESP32의 응답을 받았을 때 실제 상태로 표시한다.

BLE 연결이 끊기면 `onDisconnect()`가 `stopVibration()`을 실행해 진동 출력을 중지하도록 작성되어 있다.

## 5. BLE 통신 규약

| 용도 | UUID | 방향 | 특징 |
| --- | --- | --- | --- |
| Service | `f3f1a000-7c5b-4f18-b0bb-7d9cb9d00001` | - | ESP32가 광고하는 서비스 |
| Telemetry | `f3f1a001-7c5b-4f18-b0bb-7d9cb9d00001` | ESP32 → 웹 | Notify, 5Hz |
| Control | `f3f1a002-7c5b-4f18-b0bb-7d9cb9d00001` | 웹 → ESP32 | Write |

### 웹 → ESP32 제어 JSON

```json
{
  "type": "control",
  "command": "start",
  "frequencyHz": 27,
  "intensityPercent": 60,
  "durationSeconds": 600,
  "channels": [1, 2, 3, 4]
}
```

`command` 값: `start`, `stop`, `update`, `sweep`.

### ESP32 → 웹 Telemetry JSON

```json
{
  "type": "telemetry",
  "timestampMs": 1760000000000,
  "status": "running",
  "frequencyHz": 27,
  "intensityPercent": 60,
  "remainingSeconds": 588,
  "channels": [
    { "id": 1, "accelerationRms": 1.84, "piezoRaw": 1240, "piezoRms": 0.73 }
  ]
}
```

ESP32는 항상 실제 적용 중인 값을 telemetry로 돌려줘야 한다. 웹은 보내고 싶은 값과 실제 적용값이 다를 때 ESP32 응답을 우선으로 표시한다.

## 6. 파일별 역할

| 파일 | 역할 |
| --- | --- |
| `app/page.tsx` | 제어 화면 전체. 슬라이더, 버튼, 센서 상태 표시 |
| `app/globals.css` | 모바일 대응 화면 디자인 |
| `lib/ble/protocol.ts` | BLE UUID, JSON TypeScript 타입, 인코더/디코더 |
| `lib/ble/client.ts` | 브라우저 Web Bluetooth 연결, 명령 쓰기, telemetry 읽기 |
| `firmware/esp32_ble/src/main.cpp` | ESP32 BLE·센서·DAC 파형 출력 기본 코드 |
| `docs/BLE_PROTOCOL.md` | ESP32와 웹이 지켜야 하는 통신 규약 |
| `services/analysis-api/app/resonance.py` | 주파수 스윕 피크 추출 및 수식 기반 확장용 함수 |
| `services/analysis-api/app/main.py` | FastAPI `/api/resonance/analyze` API |
| `README.md` | 로컬 실행 방법 |

## 7. 현재 검증 결과

- Next.js production build 성공
- `http://localhost:3000` 응답 200 확인
- Python `analyse_sweep()` 테스트 성공
- ESP32 코드는 실제 보드 업로드/컴파일은 아직 하지 않음

## 8. 다음 작업 순서

1. 사용할 ESP32 보드가 ESP32 classic인지 확인한다. 현재 DAC 코드는 classic ESP32의 GPIO25를 가정한다.
2. 실제 LSM6DSOX I2C 주소와 SDA/SCL 핀을 확인한다.
3. 피에조 센서 ADC 핀을 확인하고 `PIEZO_PIN`을 수정한다.
4. Arduino IDE에 `ArduinoJson`, `Adafruit LSM6DSOX`, `Adafruit Unified Sensor`를 설치한다.
5. `firmware/esp32_ble/src/main.cpp`를 업로드한다.
6. Chrome 또는 Edge에서 `pnpm dev`를 실행하고 `http://localhost:3000`을 연다.
7. ESP32 연결 버튼을 눌러 `BreathTokTok-ESP32`를 선택한다.
8. 주파수·강도·시간을 바꾸고, Serial Monitor와 웹의 telemetry 값이 함께 바뀌는지 확인한다.
9. 센서가 여러 패널에 각각 있는 경우 채널별 I2C/ADC 입력과 telemetry 배열을 확장한다.
10. 실제 주파수 스윕 펌웨어와 웹→Python API 연결을 추가한다.

## 9. 주의해야 할 기술 사실

- Web Bluetooth는 Chrome/Edge에서 `http://localhost` 또는 HTTPS에서 사용한다. 일반 HTTP 원격 주소에서는 동작하지 않을 수 있다.
- iPhone Safari는 Web Bluetooth 지원이 제한적이므로 1차 발표는 Windows Chrome/Edge 또는 Android Chrome을 권장한다.
- ESP32 internal DAC는 ESP32 classic을 전제로 한다. ESP32-S3 등에는 외부 I2S DAC와 다른 코드가 필요하다.
- 현재 `channels` UI는 4개를 선택할 수 있으나, 펌웨어 센서 예제는 CH 1만 읽는다. 2~4번의 배선과 센서 주소/ADC 핀이 정해진 뒤 확장해야 한다.
- `sweep` 명령은 통신 규약과 버튼만 준비되어 있다. 자동으로 15–50Hz를 스캔해 Python API로 보내는 로직은 다음 작업이다.
