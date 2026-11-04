import { createDemoSweepSamples, DemoClient } from "./ble/demo";
import { ControlCommand, DeviceClient, DeviceInfo, MAX_STIMULATION_FREQUENCY_HZ, MIN_STIMULATION_FREQUENCY_HZ, Settings, Telemetry, makeControlCommand } from "./ble/protocol";
import { SweepResult, SweepSample, analyseSweep } from "./analysis";
import { StimulationArea, TonePlayer } from "./audio/tone";

export type SessionView = {
  mode: "offline" | "device"; info: DeviceInfo | null; telemetry: Telemetry | null;
  busy: boolean; playing: boolean; sweeping: boolean; progress: number; sweepHz: number | null;
  message: string; result: SweepResult | null; samples: SweepSample[]; resultMode: "device" | "demo" | null;
};
const initialView: SessionView = {
  mode: "offline", info: null, telemetry: null, busy: false, playing: false, sweeping: false,
  progress: 0, sweepHz: null, message: "연결 확인 후 스윕 측정을 시작할 수 있습니다.", result: null, samples: [], resultMode: null,
};
const sweepFrequencies = Array.from(
  { length: MAX_STIMULATION_FREQUENCY_HZ - MIN_STIMULATION_FREQUENCY_HZ + 1 },
  (_, index) => MIN_STIMULATION_FREQUENCY_HZ + index,
);
const MIN_SWEEP_SAMPLE_RATE_HZ = 200;
const SWEEP_SENSOR_READY_TIMEOUT_MS = 6000;

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
    private clientFactory: (demo: boolean) => DeviceClient = () => new DemoClient(),
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
    if (data.status === "error") {
      const message = data.error || "ESP32 센서 오류를 확인하세요.";
      if (this.view.sweeping) {
        if (this.collect) this.collect.invalid = data;
        this.patch({ message: message });
      } else this.patch({ message: message + " · 오디오 출력은 별도로 유지됩니다." });
      return;
    }
    const collector = this.collect;
    if (collector && performance.now() >= collector.after && (data.imu.measurement.state === "complete" || data.imu.measurement.state === "invalid") &&
      data.imu.measurement.frequencyHz === collector.hz) {
      const measurement = data.imu.measurement;
      if (measurement.quality === "MEASURE_OK" && measurement.fundamentalAccelerationRms !== null &&
        measurement.sampleRateHz >= MIN_SWEEP_SAMPLE_RATE_HZ && measurement.sampleCount >= 64) collector.windows.push(data);
      else collector.invalid = data;
    }
  };

  async connect() {
    if (this.view.busy) return;
    await this.disconnect();
    const epoch = ++this.epoch;
    this.patch({ busy: true, message: "연결 상태를 확인합니다." });
    const client = this.clientFactory(false);
    this.client = client;
    try {
      const info = await client.connect(this.receive, () => {
        if (this.client !== client) return;
        const audioOnlyActive = this.view.playing && !this.view.sweeping;
        this.cancel?.abort();
        if (audioOnlyActive) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
        else { this.audio.stop(); this.clearTimers(); }
        this.collect = undefined; this.sessionId = "";
        this.client = undefined;
        this.patch({ mode: "offline", info: null, telemetry: null, playing: audioOnlyActive, sweeping: false, busy: false,
          message: audioOnlyActive ? "ESP32 연결은 끊겼지만 오디오 출력은 계속됩니다." : "ESP32 연결이 해제됐습니다." });
      }, (message) => this.patch({ message }));
      if (epoch !== this.epoch || this.disposed) { client.disconnect(); return; }
      this.patch({
        mode: "device", info,
        message: "연결 확인이 완료되었습니다. 스윕 측정을 시작할 수 있습니다.",
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
    const audioOnlyActive = this.view.playing && !this.view.sweeping;
    this.cancel?.abort();
    if (audioOnlyActive) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    else { this.audio.stop(); this.clearTimers(); }
    this.collect = undefined;
    const client = this.client; this.client = undefined; client?.disconnect();
    this.patch({ mode: "offline", info: null, telemetry: null, playing: audioOnlyActive, sweeping: false, busy: false,
      message: stopWarning || (audioOnlyActive ? "센서 연결이 해제됐고 오디오 출력은 계속됩니다." : "연결이 해제되었습니다.") });
  }

  selectOutput() { return this.audio.selectOutput(); }
  private async prepareSweepSensor(settings: Settings, signal: AbortSignal) {
    if (!this.client || !this.view.telemetry || performance.now() - this.receivedAt > 4000) {
      throw new Error("ESP32의 최신 센서 데이터를 먼저 수신해 주세요.");
    }
    await this.send("prepare", settings, this.sessionId);
    const deadline = performance.now() + SWEEP_SENSOR_READY_TIMEOUT_MS;
    const sensorsReady = () => {
      const telemetry = this.view.telemetry;
      const imuReady = !!telemetry?.imu.ready && telemetry.imu.sampleRateHz >= MIN_SWEEP_SAMPLE_RATE_HZ;
      const powerReady = !!telemetry?.power.ready && telemetry.power.calibrated &&
        telemetry.power.busVoltageV !== null && telemetry.power.currentA !== null;
      return imuReady && powerReady;
    };
    while (!sensorsReady() && performance.now() < deadline) {
      await delay(150, signal);
    }
    if (!this.view.telemetry?.imu.ready || this.view.telemetry.imu.sampleRateHz < MIN_SWEEP_SAMPLE_RATE_HZ) {
      throw new Error("MPU6050 가속도 센서가 스윕 측정에 필요한 200 Hz 이상 샘플링을 확인하지 못했습니다.");
    }
    if (!sensorsReady()) throw new Error("INA226 전류센서 응답을 확인하지 못했습니다.");
  }

  async start(settings: Settings, area: StimulationArea) {
    if (this.view.busy || this.view.playing || this.stopping) return;
    this.cancel = new AbortController();
    const signal = this.cancel.signal;
    this.patch({ busy: true });
    try {
      this.settings = settings; this.area = area;
      await this.audio.prepare();
      if (signal.aborted) return;
      this.audio.start(settings.frequencyHz, settings.intensityPercent, settings.durationSeconds, area);
      this.patch({ playing: true, message: "선택한 오디오 출력으로 진동음을 재생하고 있습니다." });
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
      this.audio.update(settings.frequencyHz, settings.intensityPercent);
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
    this.patch({ busy: true, sweeping: true, result: null, resultMode: "demo", samples: [], progress: 0,
      message: "스윕 데이터를 생성합니다." });
    try {
      this.settings = settings; this.area = area;
      const demo = createDemoSweepSamples(settings.intensityPercent);
      const ordered = [...demo.samples].sort((left, right) => left.hz - right.hz);
      const samples: SweepSample[] = [];
      for (const [index, sample] of ordered.entries()) {
        await delay(160, signal);
        if (signal.aborted) return;
        samples.push(sample);
        this.patch({ sweepHz: sample.hz, samples: [...samples], progress: (index + 1) / ordered.length,
          message: `스윕 측정 중 · ${sample.hz} Hz` });
      }
      const result = await analyseSweep(samples, signal);
      if (!signal.aborted) this.patch({ result, resultMode: "demo", message: "스윕 측정이 완료되었습니다." });
    } catch (error) {
      if (!signal.aborted) this.patch({ message: this.error(error) });
    } finally {
      this.patch({ playing: false, sweeping: false, busy: false, sweepHz: null });
    }
  }

  exportResult() {
    if (!this.view.samples.length) return;
    const source = this.view.resultMode ?? "device";
    const data = {
      recordedAt: new Date().toISOString(), source,
      hardware: source === "demo" ? "임의 생성 스윕 데이터" : "ZK-502C Bluetooth audio + ESP32 MPU6050 + INA226",
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
