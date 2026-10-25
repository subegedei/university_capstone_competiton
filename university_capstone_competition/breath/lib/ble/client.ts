import { BLE_CONTROL_UUID, BLE_INFO_UUID, BLE_SERVICE_UUID, BLE_TELEMETRY_UUID, COMMAND_TIMEOUT_MS,
  TELEMETRY_TIMEOUT_MS, ControlCommand, DeviceClient, DeviceInfo, Telemetry, JsonLineDecoder, encodeCommand, parseDeviceInfo } from "./protocol";

export class BreathBleClient implements DeviceClient {
  private device?: BluetoothDevice;
  private control?: BluetoothRemoteGATTCharacteristic;
  private telemetry?: BluetoothRemoteGATTCharacteristic;
  private frames = new JsonLineDecoder();
  private watchdog?: ReturnType<typeof setInterval>;
  private lastTelemetryAt = 0;
  private bootId?: string;
  private sequence = -1;
  private pending?: { id: string; session: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private onDisconnect?: () => void;
  private onError?: (message: string) => void;
  private notify?: (event: Event) => void;
  private disconnected = () => this.cleanup(true);

  async connect(onTelemetry: (data: Telemetry) => void, onDisconnect: () => void, onError: (message: string) => void): Promise<DeviceInfo> {
    if (!window.isSecureContext) throw new Error("ESP32 연결은 localhost 또는 HTTPS에서 사용하세요.");
    if (!navigator.bluetooth) throw new Error("ESP32 연결은 Android Chrome 또는 컴퓨터 Chrome/Edge에서 사용하세요.");
    this.disconnect();
    this.onDisconnect = onDisconnect; this.onError = onError;
    try {
      this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE_UUID] }] });
      this.device.addEventListener("gattserverdisconnected", this.disconnected);
      const server = await this.device.gatt?.connect();
      if (!server) throw new Error("ESP32 GATT 연결에 실패했습니다.");
      const service = await server.getPrimaryService(BLE_SERVICE_UUID);
      let info: DeviceInfo;
      try {
        const characteristic = await service.getCharacteristic(BLE_INFO_UUID);
        info = parseDeviceInfo(new TextDecoder().decode(await characteristic.readValue()));
      } catch (error) {
        throw new Error(error instanceof Error && error.message.includes("규약") ? error.message : "장치 정보가 없습니다. ESP32에 통신 규약 v3 펌웨어가 필요합니다.");
      }
      this.control = await service.getCharacteristic(BLE_CONTROL_UUID);
      this.telemetry = await service.getCharacteristic(BLE_TELEMETRY_UUID);
      this.notify = (event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        let messages;
        try {
          messages = this.frames.push(value);
        } catch (error) {
          // Notifications are not acknowledged. A lost 20-byte fragment corrupts only that NDJSON line;
          // keep the sensor connection alive so the following telemetry frame can recover it.
          this.frames.reset();
          this.onError?.("손상된 BLE 센서 프레임 1개를 건너뛰었습니다: " + (error instanceof Error ? error.message : "메시지 오류"));
          return;
        }
        try {
          for (const message of messages) {
            if (message.type === "ack") {
              if (this.pending?.id === message.commandId && this.pending.session === message.sessionId) {
                const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
                if (message.accepted) pending.resolve(); else pending.reject(new Error(message.error || "ESP32가 명령을 거절했습니다."));
              }
            } else {
              if (this.bootId && message.bootId !== this.bootId) throw new Error("ESP32가 재부팅되었습니다. 다시 연결하세요.");
              if (message.sequence <= this.sequence) continue;
              this.bootId = message.bootId; this.sequence = message.sequence; this.lastTelemetryAt = performance.now();
              onTelemetry(message);
            }
          }
        } catch (error) { this.fail(error instanceof Error ? error.message : "BLE 메시지 오류"); }
      };
      this.telemetry.addEventListener("characteristicvaluechanged", this.notify);
      await this.telemetry.startNotifications();
      this.lastTelemetryAt = performance.now();
      this.watchdog = setInterval(() => {
        if (performance.now() - this.lastTelemetryAt > TELEMETRY_TIMEOUT_MS) this.fail("ESP32 센서 수신이 4초 이상 멈췄습니다. 연결을 해제합니다. 장치의 자동 정지를 확인하세요.");
      }, 500);
      return info;
    } catch (error) { this.disconnect(); throw error; }
  }

  async send(command: ControlCommand) {
    const control = this.control;
    if (!control || !this.device?.gatt?.connected) throw new Error("ESP32가 연결되어 있지 않습니다.");
    if (this.pending) throw new Error("이전 명령의 확인을 기다리고 있습니다.");
    const chunks = encodeCommand(command);
    const confirmed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("ESP32 명령 확인 시간 초과. 펌웨어의 ACK 응답을 확인하세요."));
      }, COMMAND_TIMEOUT_MS);
      this.pending = { id: command.commandId, session: command.sessionId, resolve, reject, timer };
    });
    void confirmed.catch(() => {});
    try {
      for (const bytes of chunks) {
        if (!this.device?.gatt?.connected) throw new Error("ESP32 연결이 해제되었습니다.");
        await control.writeValueWithResponse(bytes as Uint8Array<ArrayBuffer>);
      }
      await confirmed;
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error("BLE 쓰기 실패"));
      this.fail(error instanceof Error ? error.message : "BLE 쓰기 실패");
      throw error;
    }
  }

  private fail(message: string) { const report = this.onError; this.disconnect(); report?.(message); }
  private rejectPending(error: Error) {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
  }
  private cleanup(notify: boolean) {
    clearInterval(this.watchdog); this.watchdog = undefined;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error("ESP32 연결이 해제되었습니다.")); this.pending = undefined; }
    if (this.telemetry && this.notify) this.telemetry.removeEventListener("characteristicvaluechanged", this.notify);
    this.device?.removeEventListener("gattserverdisconnected", this.disconnected);
    this.control = undefined; this.telemetry = undefined; this.notify = undefined;
    this.frames.reset(); this.bootId = undefined; this.sequence = -1;
    const callback = this.onDisconnect; this.onDisconnect = undefined;
    if (notify) callback?.();
  }
  disconnect() { const device = this.device; this.cleanup(true); this.device = undefined; device?.gatt?.disconnect(); }
}
