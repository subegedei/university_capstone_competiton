# 인수인계 — 2026-10-24 v3



웹 → Bluetooth LE → ESP32 → GPIO25 아날로그 신호 → 규격이 확인된 앰프 → 진동자.
센서값은 BNO085/INA226 → ESP32 → BLE → 웹으로 돌아옵니다.
웹 오디오/A2DP 앰프 페어링은 사용하지 않습니다. 진동자는 최종 회로도에도 남아 있습니다.
GPIO25는 전원 출력이 아닙니다. 모터나 진동자를 직접 연결하지 않습니다.

## 실행

이 폴더에서 터미널 1:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

노트북 Chrome/Edge에서 http://localhost:3000 을 엽니다.
스윕 분석은 Next.js API 경로에서 처리하므로 별도 Python/Render 분석 서버가 필요하지 않습니다.
연결 모달의 확인 버튼 → 브라우저의 Breath-ESP32 선택 → 연결 완료.
모달만으로 브라우저 장치 선택을 건너뛸 수는 없습니다.
장치 없이 확인하려면 '먼저 둘러보기' → '장치 없이 데모'를 사용합니다.

## 펌웨어

firmware/esp32_ble/breath_esp32/breath_esp32.ino 및 config.h.
기본 OUTPUT_ENABLED=false: BLE와 센서만 확인하며 출력은 잠금 상태입니다.
드라이버 모델/입력/정격/AC 결합/접지를 확인한 담당자가 출력 허용 여부를 결정해야 합니다.
config.h의 SHUNT_OHMS=0은 전류 보정 전 상태를 뜻하며 전류·전력은 null입니다.

## 발표

Android Chrome + HTTPS 웹 주소 + 가까운 ESP32가 필요합니다.
iPhone 기본 브라우저는 이 Web Bluetooth 방식의 시연 대상으로 잡지 마세요.
한 번에 한 조작자 기준입니다. 다음 사람은 이전 연결을 해제한 뒤 연결합니다.
서버는 웹과 분석을 제공하지만, Bluetooth 연결은 심사위원 휴대폰과 ESP32 사이입니다.
현재 공개 HTTPS 배포와 QR 생성은 하지 않았습니다.
노트북의 localhost 주소를 QR로 만들어도 다른 휴대폰에서 노트북 웹에 연결되지 않습니다.

## 검사

```powershell
pnpm typecheck
pnpm test
pnpm build
```

통신 계약: docs/BLE_PROTOCOL.md. 실물 준비: docs/FIRMWARE_HANDOFF.md.
루트 폴더의 '내일_현장_작업_순서.md'를 먼저 읽으세요.

