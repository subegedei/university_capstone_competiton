export const BLE_SERVICE_UUID = "f3f1a000-7c5b-4f18-b0bb-7d9cb9d00001";
export const BLE_TELEMETRY_UUID = "f3f1a001-7c5b-4f18-b0bb-7d9cb9d00001";
export const BLE_CONTROL_UUID = "f3f1a002-7c5b-4f18-b0bb-7d9cb9d00001";
export const BLE_INFO_UUID = "f3f1a003-7c5b-4f18-b0bb-7d9cb9d00001";
export const PROTOCOL_VERSION = 3;
export const COMMAND_TIMEOUT_MS = 5000;
export const TELEMETRY_TIMEOUT_MS = 4000;
export type DeviceStatus = "idle" | "running" | "sweeping" | "error";
export type Settings = { frequencyHz: number; intensityPercent: number; durationSeconds: number };
export type ControlCommand = Settings & {
  type: "control"; protocolVersion: 3; commandId: string; sessionId: string;
  command: "start" | "stop" | "update" | "sweep" | "heartbeat";
};
export type DeviceInfo = {
  protocolVersion: 3; firmwareVersion: string; audioSource: "esp32-dac";
  sensors: { imu: "BNO085"; power: "INA226" }; outputMode: "common"; outputEnabled: boolean;
};
export type Telemetry = {
  type: "telemetry"; protocolVersion: 3; bootId: string; sequence: number;
  uptimeMs: number; sessionId: string; status: DeviceStatus;
  frequencyHz: number; intensityPercent: number; remainingSeconds: number;
  imu: { ready: boolean; linearAcceleration: { x: number; y: number; z: number } | null;
    accelerationRms: number | null; sampleCount: number; sampleRateHz: number };
  power: { ready: boolean; calibrated: boolean; busVoltageV: number | null;
    currentA: number | null; powerW: number | null };
  error?: string;
};
export type Ack = { type: "ack"; protocolVersion: 3; commandId: string; sessionId: string; accepted: boolean; error?: string };
export type DeviceMessage = Telemetry | Ack;
export type DeviceClient = {
  connect(onTelemetry: (data: Telemetry) => void, onDisconnect: () => void, onError: (message: string) => void): Promise<DeviceInfo>;
  send(command: ControlCommand): Promise<void>;
  disconnect(): void;
};

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function numberIn(value: unknown, min: number, max = Infinity) { return finite(value) && value >= min && value <= max; }
function optionalNumber(value: unknown, min = -Infinity) { return value === null || numberIn(value, min); }
function id(value: unknown) { return typeof value === "string" && value.length <= 64; }

export function parseDeviceInfo(raw: string): DeviceInfo {
  const data: unknown = JSON.parse(raw);
  if (!record(data) || data.protocolVersion !== 3 || typeof data.firmwareVersion !== "string" ||
    data.audioSource !== "esp32-dac" || typeof data.outputEnabled !== "boolean" ||
    data.outputMode !== "common" || !record(data.sensors) ||
    data.sensors.imu !== "BNO085" || data.sensors.power !== "INA226") {
    throw new Error("이 펌웨어는 BNO085·INA226 통신 규약 v3와 일치하지 않습니다. docs/BLE_PROTOCOL.md를 확인하세요.");
  }
  return data as DeviceInfo;
}

export function parseDeviceMessage(raw: string): DeviceMessage {
  const data: unknown = JSON.parse(raw);
  if (!record(data) || data.protocolVersion !== 3 || !id(data.sessionId)) throw new Error("BLE 메시지 버전 또는 세션이 잘못되었습니다.");
  if (data.type === "ack" && id(data.commandId) && typeof data.accepted === "boolean" &&
      (data.error === undefined || typeof data.error === "string")) return data as Ack;
  if (data.type !== "telemetry" || !id(data.bootId) || !data.bootId || !Number.isSafeInteger(data.sequence) || !numberIn(data.sequence, 0) ||
      !numberIn(data.uptimeMs, 0) || !["idle", "running", "sweeping", "error"].includes(String(data.status)) ||
      !numberIn(data.frequencyHz, 15, 50) || !numberIn(data.intensityPercent, 0, 100) || !numberIn(data.remainingSeconds, 0, 1800) ||
      !record(data.imu) || !record(data.power) || typeof data.imu.ready !== "boolean" || typeof data.power.ready !== "boolean" ||
      typeof data.power.calibrated !== "boolean" || !optionalNumber(data.imu.accelerationRms, 0) ||
      !Number.isSafeInteger(data.imu.sampleCount) || !numberIn(data.imu.sampleCount, 0) || !numberIn(data.imu.sampleRateHz, 0) ||
      !optionalNumber(data.power.busVoltageV, 0) || !optionalNumber(data.power.currentA) || !optionalNumber(data.power.powerW) ||
      (data.error !== undefined && typeof data.error !== "string")) throw new Error("ESP32 센서 메시지 형식이 잘못되었습니다.");
  const axes = data.imu.linearAcceleration;
  if (axes !== null && (!record(axes) || !finite(axes.x) || !finite(axes.y) || !finite(axes.z))) throw new Error("BNO085 가속도 값이 잘못되었습니다.");
  return data as Telemetry;
}

/** NDJSON is split into <=20-byte ATT values; a notification is not a whole JSON message. */
export class JsonLineDecoder {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  push(bytes: AllowSharedBufferSource): DeviceMessage[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.buffer.length > 8192) { this.reset(); throw new Error("BLE 메시지가 너무 깁니다."); }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim()).map(parseDeviceMessage);
  }
  reset() { this.buffer = ""; this.decoder = new TextDecoder("utf-8", { fatal: true }); }
}

export function encodeCommand(command: ControlCommand): Uint8Array[] {
  if (command.type !== "control" || command.protocolVersion !== 3 ||
      !["start", "stop", "update", "sweep", "heartbeat"].includes(command.command) ||
      !id(command.commandId) || !id(command.sessionId) || !numberIn(command.frequencyHz, 15, 50) || !numberIn(command.intensityPercent, 0, 100) ||
      !Number.isInteger(command.durationSeconds) || !numberIn(command.durationSeconds, 1, 1800) || !command.sessionId || !command.commandId) {
    throw new Error("주파수·강도·시간 설정을 확인하세요.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(command) + "\n");
  return Array.from({ length: Math.ceil(bytes.length / 20) }, (_, index) => bytes.slice(index * 20, index * 20 + 20));
}

export function makeControlCommand(command: ControlCommand["command"], settings: Settings, sessionId: string): ControlCommand {
  return { type: "control", protocolVersion: 3, commandId: crypto.randomUUID(), sessionId, command, ...settings };
}
