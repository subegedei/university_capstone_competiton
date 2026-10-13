export const BLE_SERVICE_UUID = "f3f1a000-7c5b-4f18-b0bb-7d9cb9d00001";
export const BLE_TELEMETRY_UUID = "f3f1a001-7c5b-4f18-b0bb-7d9cb9d00001";
export const BLE_CONTROL_UUID = "f3f1a002-7c5b-4f18-b0bb-7d9cb9d00001";

export type DeviceStatus = "idle" | "running" | "sweeping" | "error";

export type ControlCommand = {
  type: "control";
  command: "start" | "stop" | "update" | "sweep";
  frequencyHz: number;
  intensityPercent: number;
  durationSeconds: number;
  channels: number[];
};

export type ChannelTelemetry = {
  id: number;
  acceleration?: { x: number; y: number; z: number };
  accelerationRms?: number;
  piezoRaw?: number;
  piezoRms?: number;
};

export type Telemetry = {
  type: "telemetry";
  timestampMs: number;
  status: DeviceStatus;
  frequencyHz: number;
  intensityPercent: number;
  remainingSeconds: number;
  channels: ChannelTelemetry[];
  error?: string;
};

export const decoder = new TextDecoder();
export const encoder = new TextEncoder();

export function makeControlCommand(
  command: ControlCommand["command"],
  settings: Omit<ControlCommand, "type" | "command">
): ControlCommand {
  return { type: "control", command, ...settings };
}
