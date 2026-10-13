import {
  BLE_CONTROL_UUID,
  BLE_SERVICE_UUID,
  BLE_TELEMETRY_UUID,
  ControlCommand,
  decoder,
  encoder,
  Telemetry,
} from "./protocol";

export class BreathBleClient {
  private device?: BluetoothDevice;
  private control?: BluetoothRemoteGATTCharacteristic;
  private telemetry?: BluetoothRemoteGATTCharacteristic;

  async connect(onTelemetry: (telemetry: Telemetry) => void, onDisconnect: () => void) {
    if (!navigator.bluetooth) throw new Error("이 브라우저는 Web Bluetooth를 지원하지 않습니다.");
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
      optionalServices: [BLE_SERVICE_UUID],
    });
    this.device.addEventListener("gattserverdisconnected", onDisconnect, { once: true });
    const server = await this.device.gatt?.connect();
    if (!server) throw new Error("ESP32 GATT 서버 연결에 실패했습니다.");
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    this.control = await service.getCharacteristic(BLE_CONTROL_UUID);
    this.telemetry = await service.getCharacteristic(BLE_TELEMETRY_UUID);
    await this.telemetry.startNotifications();
    this.telemetry.addEventListener("characteristicvaluechanged", (event) => {
      const raw = decoder.decode((event.target as BluetoothRemoteGATTCharacteristic).value);
      try { onTelemetry(JSON.parse(raw) as Telemetry); } catch { /* Ignore incomplete/invalid packet. */ }
    });
    return this.device.name || "ESP32 흉벽 진동기";
  }

  async send(command: ControlCommand) {
    if (!this.control) throw new Error("ESP32가 연결되어 있지 않습니다.");
    await this.control.writeValueWithResponse(encoder.encode(JSON.stringify(command)));
  }

  disconnect() { this.device?.gatt?.disconnect(); }
}
