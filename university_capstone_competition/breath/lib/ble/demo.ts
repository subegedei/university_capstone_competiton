import { ControlCommand, DeviceClient, DeviceInfo, Settings, Telemetry, encodeCommand } from "./protocol";
import type { SweepSample } from "../analysis";

export function randomDemoPeakHz() {
  return 32 + Math.floor(Math.random() * 4);
}

export function createDemoSweepSamples(intensityPercent = 50, measuredSamples: SweepSample[] = []): { peakHz: number; samples: SweepSample[] } {
  const peakHz = randomDemoPeakHz();
  const intensityScale = Math.max(0.35, intensityPercent / 50);
  const measuredByHz = new Map(measuredSamples.map((sample) => [sample.hz, sample]));
  const anchors = [...measuredSamples].sort((a, b) => a.hz - b.hz);
  const generated = Array.from({ length: 16 }, (_, index) => {
    const hz = 25 + index;
    const shape = Math.exp(-0.5 * (((hz - peakHz) / 2.2) ** 2));
    const ripple = 1 + 0.012 * Math.sin((hz - 25) * 1.17);
    const velocityRms = (0.00025 + 0.0036 * intensityScale * shape) * ripple;
    const accelerationRms = velocityRms * 2 * Math.PI * hz;
    const busVoltageV = 20 + 0.12 * Math.cos((hz - 25) * 0.8);
    const currentA = 0.18 + 0.28 * intensityScale * shape;
    return {
      hz, accelerationRms, busVoltageV, currentA, powerW: busVoltageV * currentA,
      windowCount: 1, sampleCount: 150, sampleRateHz: 250,
    };
  });
  const samples = generated.map((sample) => {
    const measured = measuredByHz.get(sample.hz);
    if (measured) return measured;

    // Keep measured points fixed and smoothly carry their displacement offset
    // into the generated portion so the plotted line joins without a jump.
    const lower = [...anchors].reverse().find((anchor) => anchor.hz < sample.hz);
    const upper = anchors.find((anchor) => anchor.hz > sample.hz);
    const baseDisplacement = sample.accelerationRms / (2 * Math.PI * sample.hz) ** 2;
    const correctionAt = (anchor: SweepSample) =>
      anchor.accelerationRms / (2 * Math.PI * anchor.hz) ** 2 -
      generated[anchor.hz - 25].accelerationRms / (2 * Math.PI * anchor.hz) ** 2;
    let correction = 0;
    if (lower && upper) {
      const ratio = (sample.hz - lower.hz) / (upper.hz - lower.hz);
      correction = correctionAt(lower) * (1 - ratio) + correctionAt(upper) * ratio;
    } else if (lower) correction = correctionAt(lower);
    else if (upper) correction = correctionAt(upper);
    const displacement = Math.max(1e-9, baseDisplacement + correction);
    return { ...sample, accelerationRms: displacement * (2 * Math.PI * sample.hz) ** 2 };
  });
  return { peakHz, samples };
}

export class DemoClient implements DeviceClient {
  private timer?: ReturnType<typeof setInterval>;
  private callback?: (data: Telemetry) => void;
  private disconnected?: () => void;
  private sequence = 0;
  private began = 0;
  private deadline = 0;
  private sessionId = "";
  private demoPeakHz = 33;
  private status: Telemetry["status"] = "idle";
  private settings: Settings = { frequencyHz: 30, intensityPercent: 20, durationSeconds: 60 };
  async connect(onTelemetry: (data: Telemetry) => void, onDisconnect: () => void): Promise<DeviceInfo> {
    this.callback = onTelemetry; this.disconnected = onDisconnect; this.began = performance.now();
    this.timer = setInterval(() => this.emit(), 200); this.emit();
    return { protocolVersion: 3, firmwareVersion: "demo-3.0", audioSource: "esp32-dac", sensors: { imu: "MPU6050", power: "INA226" }, outputMode: "common", outputEnabled: true };
  }
  async send(command: ControlCommand) {
    if (!this.timer) throw new Error("데모 연결이 해제되었습니다.");
    encodeCommand(command);
    if (command.command === "heartbeat") return;
    this.settings = command; this.sessionId = command.sessionId;
    if (command.command === "stop") this.status = "idle";
    if (command.command === "start" || command.command === "sweep") {
      if (command.command === "sweep") this.demoPeakHz = randomDemoPeakHz();
      this.status = command.command === "sweep" ? "sweeping" : "running";
      this.deadline = performance.now() + command.durationSeconds * 1000;
    }
    if (command.command === "measure" && this.status === "idle") {
      this.demoPeakHz = randomDemoPeakHz();
      this.status = "sweeping";
      this.deadline = performance.now() + command.durationSeconds * 1000;
    }
    this.emit();
  }
  private emit() {
    if (this.status !== "idle" && performance.now() >= this.deadline) this.status = "idle";
    const active = this.status !== "idle";
    const shape = Math.exp(-0.5 * (((this.settings.frequencyHz - this.demoPeakHz) / 2.2) ** 2));
    const intensityScale = Math.max(0.35, this.settings.intensityPercent / 50);
    const velocityRms = active ? 0.00025 + 0.0036 * intensityScale * shape : 0.00008;
    const response = velocityRms * 2 * Math.PI * this.settings.frequencyHz;
    const current = active ? 0.18 + 0.28 * intensityScale * shape : 0.04;
    const busVoltage = 20 + 0.12 * Math.cos((this.settings.frequencyHz - 25) * 0.8);
    this.callback?.({ type: "telemetry", protocolVersion: 3, bootId: "demo-boot", sequence: this.sequence++, uptimeMs: Math.floor(performance.now() - this.began),
      sessionId: this.sessionId, status: this.status, frequencyHz: this.settings.frequencyHz, intensityPercent: this.settings.intensityPercent,
      remainingSeconds: active ? Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000)) : 0,
      imu: { ready: true, linearAcceleration: { x: response * 0.3, y: response * 0.1, z: response }, accelerationRms: response, sampleCount: 50, sampleRateHz: 250,
        measurement: { state: "complete", frequencyHz: this.settings.frequencyHz, fundamentalAccelerationRms: response, fitR2: 0.95, quality: "MEASURE_OK", sampleCount: 400, sampleRateHz: 250 } },
      power: { ready: true, calibrated: true, busVoltageV: busVoltage, currentA: current, powerW: current * busVoltage } });
  }
  disconnect() { clearInterval(this.timer); this.timer = undefined; this.status = "idle"; this.callback = undefined; this.disconnected?.(); this.disconnected = undefined; }
}
