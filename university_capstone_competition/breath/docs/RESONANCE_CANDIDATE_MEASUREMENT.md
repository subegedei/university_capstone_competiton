# 공진 후보 측정 자료와 통합 범위

이 브랜치는 기존 동작 코드를 보존한 상태에서, 공진 후보 판정 개선안을 검토하고 통합하기 위한 자료를 담는다.

## 포함 자료

- `references/resonance-frequency-correction-final-report.pdf`: 주파수 보정계수와 내부 피크 판정 검증 보고서
- `references/log-scale-resonance-candidate-analysis.pdf`: 로그 표시와 기본파 기반 후보 판정 설명 및 전체 측정 예제
- `../firmware/esp32_ble/examples/bno085-log-scale-candidate-measurement.ino`: BNO085 기본파 측정 전용 Arduino 예제
- `references/log-scale-kt-resonance-candidate-analysis.pdf`: Kt 모델 기반 추정의 가정과 입력 조건을 보완한 분석 자료
- `../firmware/esp32_ble/examples/bno085-log-scale-kt-candidate-measurement.ino`: 코일 전류를 별도로 입력받는 Kt 측정 전용 Arduino 예제

## 예제 INO의 역할

예제는 트랜스듀서를 구동하지 않는 USB Serial 측정 도구다. `M,<Hz>`로 이미 외부에서 설정된 주파수를 입력하면, 안정화 후 BNO085의 한 축 데이터를 수집하고 다음을 수행한다.

1. 구동 주파수의 sin/cos 성분을 회귀해 기본파 가속도 RMS를 산출한다.
2. `A / (2*pi*f)` 속도 RMS와 로그 표시용 지표를 계산한다.
3. 속도 RMS가 양쪽 이웃보다 큰 내부 주파수만 예비 후보로 출력한다.
4. 경계 최댓값은 후보로 확정하지 않는다.

이 예제의 `M`, `S`, `L`, `C`, `X` Serial 명령은 현재 웹 BLE 프로토콜과 호환되지 않는다. 따라서 `breath_esp32.ino`를 이 파일로 교체하면 BLE, INA226, 출력 잠금, 연결 해제 시 정지, 현재 JSON 텔레메트리를 잃게 된다.

## 현재 펌웨어에 통합할 항목

현재 펌웨어의 BLE, 안전 정지, 출력 제어, INA226 로직은 유지한다. 이후 통합 작업에서는 다음만 이식한다.

- 흉벽 법선 방향으로 확인된 단일 측정축
- 주파수 변경 뒤의 안정화 구간과 기본파 샘플 수집
- sin/cos 회귀 기반 기본파 RMS, 샘플링률, 적합도(R²), 누락 여부
- `A / (2*pi*f)` 기준의 내부 피크와 `NO_INTERIOR_PEAK` 상태

INA226의 앰프 공급 전류는 코일 교류 전류나 흉벽 전달력으로 사용하지 않는다. 결과 명칭은 공진 확정값이 아닌 **예비 응답 피크 후보**로 유지한다.

## Kt 예제의 제한

Kt 예제는 `m*x'' + c*x' + k*x = Kt*i`라는 단일 자유도 모델을 조건부로 계산한다. 실제 코일 기본파 RMS 전류와, 같은 기계 좌표로 독립 확인한 `m`, `c`, `k`가 모두 있어야 한다.

- `P,m,c,k`로 모델 값을 설정한다. 값이 없으면 Kt 계산은 `MODEL_UNSET`으로 끝난다.
- `M,f,I`는 외부 구동기가 `f` Hz에서 안정된 상태일 때 기본파 코일 RMS 전류 `I`를 함께 기록한다.
- `K,f,a,I`는 기존의 기본파 가속도 RMS `a`와 독립 전류 측정값으로 수동 계산한다.
- `KT_EST`는 교정된 힘상수나 흉벽 전달력 값이 아니라 모델 기반 추정값이다. 같은 데이터의 후보 순위나 주파수 보정에는 재사용하지 않는다.

현재 INA226은 앰프 전원 측에 있으므로 위 `I`에 넣을 수 없다. 이 조건을 만족하는 외부 전류 계측값이 없어서, 생산 BLE 펌웨어와 Next.js/Python 분석 로직에는 Kt 계산을 이식하지 않았다.

## 범위

참고 예제의 검증 범위는 20-45 Hz이지만, 현재 프로젝트의 주파수 제한은 25-40 Hz다. 이 브랜치에서 예제를 추가한 것만으로 해당 안전 제한을 변경하지 않는다.
