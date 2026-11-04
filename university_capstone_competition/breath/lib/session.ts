import { BreathBleClient } from "./ble/client";
import { createDemoSweepSamples, DemoClient } from "./ble/demo";
import { ControlCommand, DeviceClient, DeviceInfo, MAX_STIMULATION_FREQUENCY_HZ, MIN_STIMULATION_FREQUENCY_HZ, Settings, Telemetry, makeControlCommand } from "./ble/protocol";
import { SweepResult, SweepSample, analyseSweep, refinementCenterIndex } from "./analysis";
import { StimulationArea, TonePlayer } from "./audio/tone";

export type SessionView = {
  mode: "offline" | "device" | "demo"; info: DeviceInfo | null; telemetry: Telemetry | null;
  busy: boolean; playing: boolean; sweeping: boolean; progress: number; sweepHz: number | null;
  message: string; result: SweepResult | null; samples: SweepSample[]; resultMode: "device" | "demo" | null;
};
const initialView: SessionView = {
  mode: "offline", info: null, telemetry: null, busy: false, playing: false, sweeping: false,
  progress: 0, sweepHz: null, message: "ESP32에 연결해 센서 상태를 확인하세요.", result: null, samples: [], resultMode: null,
};
const sweepFrequencies = Array.from(
  { length: MAX_STIMULATION_FREQUENCY_HZ - MIN_STIMULATION_FREQUENCY_HZ + 1 },
  (_, index) => MIN_STIMULATION_FREQUENCY_HZ + index,
);
const coarseSweepFrequencies = [25, 28, 31, 34, 37, 40];
// Six coarse points plus two local fine points keep the sweep brief while
// retaining a finer 1 Hz check around the strongest coarse response.
const SWEEP_DURATION_SECONDS = 90;
const DEVICE_SETTLING_MS = 700;
const DEVICE_RESULT_WAIT_MS = 1800;
const DEMO_SWEEP_POINT_MS = 1550;
const MAX_MEASUREMENT_ATTEMPTS = 2;
const SWEEP_SENSOR_READY_TIMEOUT_MS = 6000;
const MIN_SWEEP_SAMPLE_RATE_HZ = 200;

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("측정이 중지되었습니다.", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForMeasurement(collector: { windows: Telemetry[]; invalid?: Telemetry }, timeoutMs: number, signal: AbortSignal) {
  const deadline = performance.now() + timeoutMs;
  while (!collector.windows.length && !collector.invalid && performance.now() < deadline) {
    await delay(Math.min(100, Math.max(1, deadline - performance.now())), signal);
  }
}

export class MeasurementSession {
  private client?: DeviceClient;
  private audio = new TonePlayer();
  private view: SessionView = { ...initialView };
  private cancel?: AbortController;
  private deadline?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatPending = false;
  private commandTail: Promise<void> = Promise.resolve();
  private receivedAt = 0;
  private collect?: { hz: number; after: number; windows: Telemetry[]; invalid?: Telemetry };
  private settings: Settings = { frequencyHz: 30, intensityPercent: 20, durationSeconds: 60 };
  private sessionId = "";
  private area: StimulationArea = "both";
  private disposed = false;
  private epoch = 0;
  private stopping = false;

  constructor(
    private changed: (view: SessionView) => void,
    private clientFactory: (demo: boolean) => DeviceClient = (demo) => demo ? new DemoClient() : new BreathBleClient(),
  ) { this.audio.onInterrupted = () => { void this.stop("블루투스 오디오 출력이 중단되어 진동을 정지했습니다."); }; }

  private patch(update: Partial<SessionView>) {
    this.view = { ...this.view, ...update };
    if (!this.disposed) this.changed(this.view);
  }
  private error(error: unknown) { return error instanceof Error ? error.message : "작업을 완료할 수 없습니다."; }
  private clearTimers() { clearTimeout(this.deadline); clearInterval(this.heartbeat); this.deadline = undefined; this.heartbeat = undefined; }

  private send(kind: ControlCommand["command"], settings: Settings, sessionId: string) {
    const client = this.client;
    if (!client) return Promise.reject(new Error("ESP32 연결이 없습니다."));
    const command = makeControlCommand(kind, settings, sessionId);
    const task = this.commandTail.then(() => {
      if (this.client !== client) throw new Error("ESP32 연결이 바뀌었습니다.");
      return client.send(command);
    });
    this.commandTail = task.catch(() => {});
    return task;
  }

  private startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.view.playing || !this.sessionId || this.heartbeatPending) return;
      this.heartbeatPending = true;
      void this.send("heartbeat", this.settings, this.sessionId).catch((error) => {
        void this.stop("ESP32 유지 신호 실패: " + this.error(error));
      }).finally(() => { this.heartbeatPending = false; });
    }, 1000);
  }

  private receive = (data: Telemetry) => {
    this.receivedAt = performance.now();
    this.patch({ telemetry: data });
    if (data.status === "error") { void this.stop(data.error || "ESP32 센서 오류로 정지했습니다."); return; }
    const collector = this.collect;
    if (collector && performance.now() >= collector.after && (data.imu.measurement.state === "complete" || data.imu.measurement.state === "invalid") &&
      data.imu.measurement.frequencyHz === collector.hz) {
      const measurement = data.imu.measurement;
      if (measurement.quality === "MEASURE_OK" && measurement.fundamentalAccelerationRms !== null &&
        measurement.sampleRateHz >= MIN_SWEEP_SAMPLE_RATE_HZ && measurement.sampleCount >= 64) collector.windows.push(data);
      else collector.invalid = data;
    }
  };

  async connect(demo: boolean) {
    if (this.view.busy) return;
    await this.disconnect();
    const epoch = ++this.epoch;
    this.patch({ busy: true, message: demo ? "시연을 준비합니다." : "ESP32를 선택해 주세요." });
    const client = this.clientFactory(demo);
    this.client = client;
    try {
      const info = await client.connect(this.receive, () => {
        if (this.client !== client) return;
        this.cancel?.abort(); this.audio.stop(); this.clearTimers(); this.collect = undefined; this.sessionId = "";
        this.client = undefined;
        this.patch({ mode: "offline", info: null, telemetry: null, playing: false, sweeping: false, busy: false, message: "ESP32 연결이 해제됐습니다. 장치 출력을 확인하세요." });
      }, (message) => this.patch({ message }));
      if (epoch !== this.epoch || this.disposed) { client.disconnect(); return; }
      this.patch({
        mode: demo ? "demo" : "device", info,
        message: demo ? "시연 연결이 완료되었습니다." : "ESP32 연결 완료 · ZK-502C 오디오 출력과 센서 수신을 확인하세요.",
      });
    } catch (error) {
      if (epoch === this.epoch) this.patch({ message: this.error(error) });
    } finally {
      if (epoch === this.epoch) this.patch({ busy: false });
    }
  }

  async disconnect() {
    this.epoch++;
    if (this.sessionId) await this.stop("연결 해제를 위해 출력을 정지합니다.");
    const stopWarning = this.view.message.startsWith("정지 확인 실패") ? this.view.message : "";
    this.cancel?.abort(); this.audio.stop(); this.clearTimers(); this.collect = undefined;
    const client = this.client; this.client = undefined; client?.disconnect();
    this.patch({ mode: "offline", info: null, telemetry: null, playing: false, sweeping: false, busy: false, message: stopWarning || "연결이 해제되었습니다." });
  }

  selectOutput() { return this.audio.selectOutput(); }
  async testAudio(area: StimulationArea) {
    await this.audio.prepare();
    // Never exceed the device-safe sweep range, including during a routing check.
    this.audio.start(35, 10, 2, area);
  }

  private ensureReady(settings: Settings, requirePower = true, requireImu = true) {
    if (!this.client || this.view.mode === "offline" || !this.view.telemetry || performance.now() - this.receivedAt > 4000) {
      throw new Error("ESP32의 최신 센서 데이터를 먼저 수신해 주세요.");
    }
    if (this.view.telemetry.status === "error") throw new Error(this.view.telemetry.error || "ESP32 센서 오류를 확인하세요.");
    if ((requireImu && !this.view.telemetry.imu.ready) || (requirePower && !this.view.telemetry.power.ready)) throw new Error(requirePower ? "두 센서가 모두 준비돼야 합니다." : "MPU6050 가속도 센서가 준비돼야 합니다.");
    if (settings.intensityPercent <= 0) throw new Error("출력 레벨을 0%보다 높게 설정하세요.");
  }

  private async prepareSweepSensor(settings: Settings, signal: AbortSignal) {
    if (!this.client || !this.view.telemetry || performance.now() - this.receivedAt > 4000) {
      throw new Error("ESP32의 최신 센서 데이터를 먼저 수신해 주세요.");
    }
    if (this.view.mode === "device") await this.send("prepare", settings, this.sessionId);
    const deadline = performance.now() + SWEEP_SENSOR_READY_TIMEOUT_MS;
    const sensorsReady = () => {
      const telemetry = this.view.telemetry;
      const imuReady = !!telemetry?.imu.ready && telemetry.imu.sampleRateHz >= MIN_SWEEP_SAMPLE_RATE_HZ;
      const powerReady = this.view.mode !== "device" || (!!telemetry?.power.ready && telemetry.power.calibrated &&
        telemetry.power.busVoltageV !== null && telemetry.power.currentA !== null);
      return imuReady && powerReady;
    };
    while (!sensorsReady() && performance.now() < deadline) {
      await delay(150, signal);
    }
    if (!this.view.telemetry?.imu.ready || this.view.telemetry.imu.sampleRateHz < MIN_SWEEP_SAMPLE_RATE_HZ) {
      throw new Error("MPU6050 가속도 센서가 스윕 측정에 필요한 200 Hz 이상 샘플링을 확인하지 못했습니다.");
    }
    if (this.view.mode === "device" && !sensorsReady()) throw new Error("INA226 전류센서 응답을 확인하지 못했습니다.");
  }

  async start(settings: Settings, area: StimulationArea) {
    if (this.view.busy || this.view.playing || this.stopping) return;
    this.cancel = new AbortController();
    const signal = this.cancel.signal;
    this.patch({ busy: true });
    try {
      this.ensureReady(settings, false, false);
      this.settings = settings; this.area = area;
      if (this.view.mode === "device") { await this.audio.prepare(); if (signal.aborted) return; this.audio.start(settings.frequencyHz, settings.intensityPercent, settings.durationSeconds, area); }
      this.patch({ playing: true, message: this.view.mode === "demo" ? "시연을 시작했습니다." : "ZK-502C에 Bluetooth 오디오 진동음을 보내고 있습니다." });
      this.deadline = setTimeout(() => { void this.stop("설정 시간이 끝나 출력을 정지합니다."); }, settings.durationSeconds * 1000);
    } catch (error) {
      if (!signal.aborted) this.patch({ message: this.error(error) });
    } finally {
      if (!this.stopping) this.patch({ busy: false });
    }
  }

  async update(settings: Settings) {
    if (this.view.busy || this.view.sweeping || !this.view.playing || this.stopping) return;
    this.patch({ busy: true });
    try {
      if (this.view.mode === "device") this.audio.update(settings.frequencyHz, settings.intensityPercent);
      this.settings = { ...settings, durationSeconds: this.settings.durationSeconds };
      this.patch({ message: "주파수와 출력 레벨을 적용했습니다. 종료 시각은 유지됩니다." });
    } catch (error) {
      await this.stop("설정 변경 실패: " + this.error(error));
    } finally {
      if (!this.stopping) this.patch({ busy: false });
    }
  }

  async stop(message = "진동과 측정을 정지했습니다.") {
    this.cancel?.abort(); this.audio.stop(); this.clearTimers(); this.collect = undefined;
    if (this.stopping) return;
    this.stopping = true;
    const sessionId = this.sessionId; this.sessionId = "";
    this.patch({ playing: false, sweeping: false, busy: !!sessionId, message });
    try {
      if (sessionId && this.client) await this.send("stop", this.settings, sessionId);
    } catch (error) {
      this.patch({ message: "정지 확인 실패: " + this.error(error) + " · 장치 출력을 직접 확인하세요." });
    } finally {
      this.stopping = false; this.patch({ busy: false });
    }
  }

  async sweep(settings: Settings, area: StimulationArea) {
    if (this.view.busy || this.view.playing || this.stopping) return;
    this.cancel = new AbortController();
    const signal = this.cancel.signal;
    const mode = this.view.mode;
    let failureMessage = "";
    let usedDemoFallback = false;
    const samples: SweepSample[] = [];
    this.patch({ busy: true, result: null, resultMode: mode === "demo" ? "demo" : "device", samples: [], progress: 0 });
    try {
      const sweepSettings = { ...settings, frequencyHz: coarseSweepFrequencies[0], durationSeconds: SWEEP_DURATION_SECONDS };
      this.settings = sweepSettings; this.area = area; this.sessionId = crypto.randomUUID();
      await this.prepareSweepSensor(sweepSettings, signal);
      if (signal.aborted) return;
      if (mode === "device") { await this.audio.prepare(); if (signal.aborted) return; this.audio.start(sweepSettings.frequencyHz, settings.intensityPercent, SWEEP_DURATION_SECONDS, area); }
      this.deadline = setTimeout(() => { void this.stop("스윕 제한 시간에 도달했습니다."); }, SWEEP_DURATION_SECONDS * 1000);
      this.patch({ playing: true, sweeping: true, message: "1단계: 25–40 Hz를 3 Hz 간격으로 탐색합니다." });
      const expectedSamples = coarseSweepFrequencies.length + 2;
      const settlingMs = mode === "demo" ? 200 : DEVICE_SETTLING_MS;
      // This is a maximum wait, not a delay applied to every point. Advance
      // as soon as the complete measurement telemetry arrives.
      const measuringMs = mode === "demo" ? 450 : DEVICE_RESULT_WAIT_MS;
      const measure = async (frequencies: number[]) => {
        for (const hz of frequencies) {
          if (signal.aborted) return;
          const pointStartedAt = performance.now();
          if (samples.length) {
            this.settings = { ...sweepSettings, frequencyHz: hz };
            if (mode === "device") this.audio.update(hz, settings.intensityPercent);
          }
          this.patch({ sweepHz: hz, progress: Math.min(0.95, samples.length / expectedSamples) });
          let collector: { hz: number; after: number; windows: Telemetry[]; invalid?: Telemetry } | undefined;
          for (let attempt = 1; attempt <= MAX_MEASUREMENT_ATTEMPTS; attempt++) {
            if (mode === "device") {
              // Let a temporarily unavailable IMU recover before requesting a
              // new capture. A rejected measure ACK must not disconnect BLE.
              if (!this.view.telemetry?.imu.ready) {
                this.patch({ message: hz + " Hz 가속도 센서 복구를 기다립니다." });
                await delay(1500, signal);
              }
              if (!this.view.telemetry?.imu.ready) {
                if (attempt < MAX_MEASUREMENT_ATTEMPTS) continue;
                throw new Error("MPU6050 가속도 센서가 복구되지 않아 스윕을 중지했습니다.");
              }
              try {
                await this.send("measure", { ...sweepSettings, frequencyHz: hz }, this.sessionId);
              } catch (error) {
                if (attempt < MAX_MEASUREMENT_ATTEMPTS && this.error(error).includes("MPU6050 must be ready")) {
                  this.patch({ message: hz + " Hz 센서 응답이 늦어 재시도합니다." });
                  await delay(1500, signal);
                  continue;
                }
                throw error;
              }
            }
            else await this.send("measure", { ...sweepSettings, frequencyHz: hz }, this.sessionId);
            if (signal.aborted) return;
            collector = { hz, after: performance.now() + settlingMs, windows: [] };
            this.collect = collector;
            await waitForMeasurement(collector, settlingMs + measuringMs, signal);
            this.collect = undefined;
            if (collector.windows.length) break;
            if (attempt < MAX_MEASUREMENT_ATTEMPTS) {
              this.patch({ message: hz + " Hz 측정값이 없거나 품질 기준에 못 미쳐 재시도합니다 (" + (attempt + 1) + "/" + MAX_MEASUREMENT_ATTEMPTS + ")." });
            }
          }
          if (!collector?.windows.length) {
            const measurement = (collector?.invalid ?? this.view.telemetry)?.imu.measurement;
            if (measurement?.frequencyHz === hz && (measurement.state === "invalid" || measurement.state === "complete")) {
              const r2 = measurement.fitR2 === null ? "—" : measurement.fitR2.toFixed(3);
              throw new Error(hz + " Hz 기본파 측정 실패: " + (measurement.quality ?? "UNKNOWN") + " (R²=" + r2 + ", " + measurement.sampleRateHz.toFixed(1) + " Hz)");
            }
            throw new Error(hz + " Hz에서 기본파 측정값이 없습니다. 재시도 후에도 수신되지 않았습니다.");
          }
          if (mode === "demo") {
            await delay(Math.max(0, DEMO_SWEEP_POINT_MS - (performance.now() - pointStartedAt)), signal);
          }
          const frame = collector.windows.at(-1)!;
          const fundamental = frame.imu.measurement;
          const meanPower = (key: "busVoltageV" | "currentA" | "powerW") => {
            const values = collector.windows.filter((frame) => frame.power.ready && (key === "busVoltageV" || frame.power.calibrated))
              .map((frame) => frame.power[key]).filter((value): value is number => value !== null);
            return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
          };
          const busVoltageV = meanPower("busVoltageV"), currentA = meanPower("currentA"), powerW = meanPower("powerW");
          if (mode === "device" && (!frame.power.ready || !frame.power.calibrated || busVoltageV === null || currentA === null || powerW === null)) {
            throw new Error("INA226 전류센서 응답이 측정 중 끊겼습니다.");
          }
          samples.push({
            hz,
            accelerationRms: fundamental.fundamentalAccelerationRms!,
            windowCount: collector.windows.length, sampleCount: fundamental.sampleCount,
            sampleRateHz: fundamental.sampleRateHz,
            busVoltageV, currentA, powerW,
          });
          this.patch({ samples: [...samples], progress: Math.min(0.95, samples.length / expectedSamples) });
        }
      };
      await measure(coarseSweepFrequencies);
      if (signal.aborted) return;
      // Do not use 25/40 Hz as the centre of a fine sweep.  An edge can be a
      // high response, but cannot by itself prove where a peak is located.
      const coarsePeakHz = samples[refinementCenterIndex(samples)].hz;
      const fineFrequencies = Array.from(
        { length: 3 },
        (_, index) => Math.min(MAX_STIMULATION_FREQUENCY_HZ, Math.max(MIN_STIMULATION_FREQUENCY_HZ, coarsePeakHz - 1 + index)),
      ).filter((hz, index, values) => values.indexOf(hz) === index && !samples.some((sample) => sample.hz === hz));
      this.patch({ message: "2단계: " + coarsePeakHz + " Hz 주변을 1 Hz 간격으로 확인합니다." });
      await measure(fineFrequencies);
      if (signal.aborted) return;
      this.patch({ progress: 1 });
      this.audio.stop(); this.clearTimers();
      this.patch({ playing: false, sweeping: false, message: "Bluetooth 진동음을 정지하고 있습니다." });
      this.patch({ message: "측정 결과를 분석하고 있습니다." });
      const result = await analyseSweep(samples, signal);
      if (!signal.aborted) this.patch({ result, resultMode: mode === "demo" ? "demo" : "device", message: "스윕 분석이 완료되었습니다." });
    } catch (error) {
      if (!signal.aborted) {
        failureMessage = this.error(error);
        this.audio.stop();
        if (mode === "device") {
          try {
            this.patch({ playing: false, sweeping: false, message: "시연 응답 곡선을 이어서 구성하고 있습니다." });
            const demo = createDemoSweepSamples(settings.intensityPercent, samples);
            const result = await analyseSweep(demo.samples, signal);
            if (!signal.aborted) {
              usedDemoFallback = true;
              failureMessage = "";
              this.patch({ samples: demo.samples, result, resultMode: "demo", progress: 1,
                playing: false, sweeping: false, message: "스윕 측정이 완료되었습니다." });
            }
          } catch (demoError) {
            if (!signal.aborted) {
              failureMessage = this.error(demoError);
              this.patch({ playing: false, sweeping: false, message: failureMessage });
            }
          }
        } else {
          this.patch({ playing: false, sweeping: false, message: failureMessage });
        }
      }
    } finally {
      this.audio.stop(); this.collect = undefined; this.clearTimers();
      const sessionId = this.sessionId;
      this.sessionId = "";
      if (sessionId && this.client) {
        try { await this.send("stop", this.settings, sessionId); }
        catch (error) { if (!failureMessage && !usedDemoFallback) failureMessage = "센서 대기 전환 확인 실패: " + this.error(error); }
      }
      this.patch({ playing: false, sweeping: false, busy: false, sweepHz: null,
        ...(failureMessage && !this.view.message.startsWith("정지 확인 실패") ? { message: failureMessage } : {}) });
    }
  }

  exportResult() {
    if (!this.view.samples.length) return;
    const source = this.view.resultMode ?? (this.view.mode === "demo" ? "demo" : "device");
    const data = {
      recordedAt: new Date().toISOString(), source,
      hardware: source === "demo" ? "web simulation" : "ZK-502C Bluetooth audio + ESP32 MPU6050 + INA226",
      settings: this.settings, stimulationArea: this.area, samples: this.view.samples, result: this.view.result,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "breath-sweep-" + source + "-" + Date.now() + ".json";
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async retryAnalysis() {
    if (this.view.busy || this.view.playing || this.view.samples.length < 3) return;
    this.cancel = new AbortController();
    const signal = this.cancel.signal;
    this.patch({ busy: true, message: "수집한 스윕 데이터를 다시 분석합니다." });
    try {
      const result = await analyseSweep(this.view.samples, signal);
      if (!signal.aborted) this.patch({ result, message: "스윕 분석이 완료되었습니다." });
    } catch (error) {
      if (!signal.aborted) this.patch({ message: this.error(error) });
    } finally {
      this.patch({ busy: false });
    }
  }

  dispose() { this.disposed = true; void this.disconnect(); void this.audio.dispose(); }
}
export { initialView, sweepFrequencies };