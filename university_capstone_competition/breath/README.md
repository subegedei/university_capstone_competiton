# 숨결톡톡 제어 대시보드

## Local development

```powershell
pnpm install
pnpm dev
```

Run the analysis API in a second terminal:

```powershell
cd services/analysis-api
python -m pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Web Bluetooth requires Chrome or Edge and a secure context (HTTPS or
`http://localhost`). See `docs/BLE_PROTOCOL.md` for the ESP32 contract.
