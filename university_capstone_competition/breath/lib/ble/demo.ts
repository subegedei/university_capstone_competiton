import { ControlCommand, DeviceClient, DeviceInfo, Settings, Telemetry, encodeCommand } from "./protocol";

export class DemoClient implements DeviceClient {
  private timer?: ReturnType<typeof setInterval>;
  private callback?: (data: Telemetry) => void;
  private disconnected?: () => void;
  private sequence = 0;
  private began = 0;
  private deadline = 0;
  private sessionId = "";
  private status: Telemetry["status"] = "idle";
  private settings: Settings = { frequencyHz: 30, intensityPercent: 20, durationSeconds: 60 };
  async connect(onTelemetry: (data: Telemetry) => void, onDisconnect: () => void): Promise<DeviceInfo> {
    this.callback = onTelemetry; this.disconnected = onDisconnect; this.began = performance.now();
    this.timer = setInterval(() => this.emit(), 200); this.emit();
    return { protocolVersion: 3, firmwareVersion: "demo-3.0", audioSource: "esp32-dac", sensors: { imu: "BNO085", power: "INA226" }, outputMode: "common", outputEnabled: true };
  }
  async send(command: ControlCommand) {
    if (!this.timer) throw new Error("데모 연결이 해제되었습니다.");
    encodeCommand(command);
    if (command.command === "heartbeat") return;
    this.settings = command; this.sessionId = command.sessionId;
    if (command.command === "stop") this.status = "idle";
    if (command.command === "start" || command.command === "sweep") {
      this.status = command.command === "sweep" ? "sweeping" : "running";
      this.deadline = performance.now() + command.durationSeconds * 1000;
    }
    this.emit();
  }
  private emit() {
    if (this.status !== "idle" && performance.now() >= this.deadline) this.status = "idle";
    const active = this.status !== "idle";
    const response = active ? this.settings.intensityPercent / 100 * (1 + 5 * Math.exp(-(((this.settings.frequencyHz - 29) / 4) ** 2))) : 0.015;
    const current = active ? 0.1 + response * 0.15 : 0.04;
    this.callback?.({ type: "telemetry", protocolVersion: 3, bootId: "demo-boot", sequence: this.sequence++, uptimeMs: Math.floor(performance.now() - this.began),
      sessionId: this.sessionId, status: this.status, frequencyHz: this.settings.frequencyHz, intensityPercent: this.settings.intensityPercent,
      remainingSeconds: active ? Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000)) : 0,
      imu: { ready: true, linearAcceleration: { x: response * 0.3, y: response * 0.1, z: response }, accelerationRms: response, sampleCount: 50, sampleRateHz: 250 },
      power: { ready: true, calibrated: true, busVoltageV: 12, currentA: current, powerW: current * 12 } });
  }
  disconnect() { clearInterval(this.timer); this.timer = undefined; this.status = "idle"; this.callback = undefined; this.disconnected?.(); this.disconnected = undefined; }
}
