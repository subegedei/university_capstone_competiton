import { TonePlayer, StimulationArea } from "./audio/tone";
import { BreathBleClient } from "./ble/client";
import { DemoClient } from "./ble/demo";
import { DeviceClient, DeviceInfo, Settings, Telemetry } from "./ble/protocol";
import { SweepResult, SweepSample, analyseSweep } from "./analysis";

export type SessionView = {
  mode: "offline" | "device" | "demo"; info: DeviceInfo | null; telemetry: Telemetry | null;
  busy: boolean; playing: boolean; sweeping: boolean; progress: number; sweepHz: number | null;
  message: string; result: SweepResult | null; samples: SweepSample[]; resultMode: "device" | "demo" | null;
};
const initialView: SessionView = {
  mode: "offline", info: null, telemetry: null, busy: false, playing: false, sweeping: false,
  progress: 0, sweepHz: null, message: "ZK-502C 오디오 출력과 ESP32 센서를 연결해 주세요.", result: null, samples: [], resultMode: null,
};
const sweepFrequencies = [20, 25, 30, 35, 40, 45];

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("측정이 중지되었습니다.", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

export class MeasurementSession {
  private client?: DeviceClient;
  private audio = new TonePlayer();
  private view: SessionView = { ...initialView };
  private cancel?: AbortController;
  private deadline?: ReturnType<typeof setTimeout>;
  private receivedAt = 0;
  private collect?: { hz: number; after: number; windows: Telemetry[] };
  private settings: Settings = { frequencyHz: 30, intensityPercent: 20, durationSeconds: 60 };
  private area: StimulationArea = "both";
  private disposed = false;
  private epoch = 0;
  private stopping = false;

  constructor(
    private changed: (view: SessionView) => void,
    private clientFactory: (demo: boolean) => DeviceClient = (demo) => demo ? new DemoClient() : new BreathBleClient(),
  ) {
    this.audio.onInterrupted = () => { void this.stop("브라우저 오디오 출력이 중단되어 측정을 정지했습니다."); };
  }

  private patch(update: Partial<SessionView>) {
    this.view = { ...this.view, ...update };
    if (!this.disposed) this.changed(this.view);
  }
  private error(error: unknown) { return error instanceof Error ? error.message : "작업을 완료할 수 없습니다."; }

  private receive = (data: Telemetry) => {
    this.receivedAt = performance.now();
    this.patch({ telemetry: data });
    if (data.status === "error") { void this.stop(data.error || "ESP32 센서 오류로 정지했습니다."); return; }
    const collector = this.collect;
    if (collector && performance.now() >= collector.after &&
      data.imu.ready && data.imu.accelerationRms !== null && data.imu.sampleCount > 0 && data.imu.sampleRateHz >= 200) {
      collector.windows.push(data);
    }
  };

  async connect(demo: boolean) {
    if (this.view.busy) return;
    this.disconnect();
    const epoch = ++this.epoch;
    this.patch({ busy: true, message: demo ? "데모 센서를 연결합니다." : "ESP32를 선택해 주세요." });
    const client = this.clientFactory(demo);
    this.client = client;
    try {
      const info = await client.connect(this.receive, () => {
        if (this.client !== client) return;
        this.cancel?.abort(); this.audio.stop(); clearTimeout(this.deadline); this.collect = undefined;
        this.patch({ mode: "offline", info: null, telemetry: null, playing: false, sweeping: false, message: "ESP32 연결이 해제되어 오디오를 정지했습니다." });
      }, (message) => this.patch({ message }));
      if (epoch !== this.epoch || this.disposed) { client.disconnect(); return; }
      this.patch({
        mode: demo ? "demo" : "device", info,
        message: demo ? "데모 연결 완료 · 가상 센서값이며 소리는 재생하지 않습니다." : "ESP32 연결 완료 · 센서 수신 상태를 확인하세요.",
      });
    } catch (error) {
      this.patch({ message: this.error(error) });
    } finally {
      if (epoch === this.epoch) this.patch({ busy: false });
    }
  }

  disconnect() {
    this.epoch++; this.cancel?.abort(); this.audio.stop(); clearTimeout(this.deadline); this.collect = undefined;
    const client = this.client; this.client = undefined; client?.disconnect();
    this.patch({ mode: "offline", info: null, telemetry: null, playing: false, sweeping: false, busy: false, message: "연결이 해제되었습니다." });
  }

  selectOutput() { return this.audio.selectOutput(); }
  async testAudio(area: StimulationArea) {
    await this.audio.prepare();
    this.audio.start(30, 5, 2, area);
  }

  private ensureReady(settings: Settings) {
    if (!this.client || this.view.mode === "offline" || !this.view.telemetry || performance.now() - this.receivedAt > 4000) {
      throw new Error("ESP32의 최신 센서 데이터를 먼저 수신해 주세요.");
    }
    if (this.view.telemetry.status === "error") throw new Error(this.view.telemetry.error || "ESP32 센서 오류를 확인하세요.");
    if (settings.intensityPercent <= 0) throw new Error("출력 레벨을 0%보다 높게 설정하세요.");
  }

  async start(settings: Settings, area: StimulationArea) {
    if (this.view.busy || this.view.playing || this.stopping) return;
    this.cancel = new AbortController();
    this.patch({ busy: true });
    try {
      this.ensureReady(settings);
      this.settings = settings; this.area = area;
      if (this.view.mode === "device") {
        await this.audio.prepare();
        if (this.cancel.signal.aborted) return;
        this.audio.start(settings.frequencyHz, settings.intensityPercent, settings.durationSeconds, area);
      }
      this.patch({ playing: true, message: this.view.mode === "demo" ? "가상 진동을 시작했습니다. 실제 소리는 재생하지 않습니다." : "휴대폰/노트북에서 앰프에 진동음을 보내고 센서를 측정합니다." });
      this.deadline = setTimeout(() => { void this.stop("설정 시간이 끝나 진동과 측정을 정지했습니다."); }, settings.durationSeconds * 1000);
    } catch (error) {
      this.audio.stop(); this.patch({ message: this.error(error) });
    } finally {
      this.patch({ busy: false });
    }
  }

  async update(settings: Settings) {
    if (this.view.busy || this.view.sweeping || !this.view.playing || this.stopping) return;
    this.patch({ busy: true });
    try {
      if (this.view.mode === "device") this.audio.update(settings.frequencyHz, settings.intensityPercent);
      this.settings = settings;
      this.patch({ message: "주파수와 출력 레벨을 적용했습니다. 종료 시각은 유지됩니다." });
    } catch (error) {
      await this.stop(this.error(error));
    } finally {
      this.patch({ busy: false });
    }
  }

  async stop(message = "진동과 측정을 정지했습니다.") {
    this.cancel?.abort(); this.audio.stop(); clearTimeout(this.deadline); this.collect = undefined;
    if (this.stopping) return;
    this.stopping = true;
    this.patch({ playing: false, sweeping: false, busy: true, message });
    this.stopping = false;
    this.patch({ busy: false });
  }

  async sweep(settings: Settings, area: StimulationArea) {
    if (this.view.busy || this.view.playing || this.stopping) return;
    this.cancel = new AbortController();
    const signal = this.cancel.signal;
    const mode = this.view.mode;
    this.patch({ busy: true, result: null, resultMode: mode === "demo" ? "demo" : "device", samples: [], progress: 0 });
    try {
      this.ensureReady(settings);
      if (!this.view.telemetry?.imu.ready || this.view.telemetry.imu.sampleRateHz < 200) throw new Error("스윕에는 BNO085 선형 가속도 200Hz 이상이 필요합니다.");
      this.settings = { ...settings, frequencyHz: sweepFrequencies[0], durationSeconds: 70 };
      this.area = area;
      if (mode === "device") await this.audio.prepare();
      if (signal.aborted) return;
      if (mode === "device") this.audio.start(sweepFrequencies[0], settings.intensityPercent, 70, area);
      this.deadline = setTimeout(() => { void this.stop("스윕 제한 시간에 도달했습니다."); }, 70000);
      this.patch({ playing: true, sweeping: true, message: "20–45 Hz를 5 Hz 간격으로 측정합니다. 출력 레벨은 일정하게 유지됩니다." });
      const samples: SweepSample[] = [];
      const settlingMs = mode === "demo" ? 200 : 1200;
      const measuringMs = mode === "demo" ? 450 : 1200;
      for (const hz of sweepFrequencies) {
        if (signal.aborted) return;
        this.settings = { ...this.settings, frequencyHz: hz };
        if (mode === "device") this.audio.update(hz, settings.intensityPercent);
        this.patch({ sweepHz: hz, progress: samples.length / sweepFrequencies.length });
        const collector = { hz, after: performance.now() + settlingMs, windows: [] as Telemetry[] };
        this.collect = collector;
        await delay(settlingMs + measuringMs, signal);
        this.collect = undefined;
        if (collector.windows.length < 2) throw new Error(hz + " Hz에서 유효한 RMS 측정값이 부족합니다. BNO085 샘플링과 BLE 수신을 확인하세요.");
        const count = collector.windows.reduce((sum, frame) => sum + frame.imu.sampleCount, 0);
        const meanPower = (key: "busVoltageV" | "currentA" | "powerW") => {
          const values = collector.windows.filter((frame) => frame.power.ready && (key === "busVoltageV" || frame.power.calibrated))
            .map((frame) => frame.power[key]).filter((value): value is number => value !== null);
          return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        };
        samples.push({
          hz,
          accelerationRms: Math.sqrt(collector.windows.reduce((sum, frame) => sum + (frame.imu.accelerationRms ?? 0) ** 2 * frame.imu.sampleCount, 0) / count),
          windowCount: collector.windows.length, sampleCount: count,
          sampleRateHz: Math.min(...collector.windows.map((frame) => frame.imu.sampleRateHz)),
          busVoltageV: meanPower("busVoltageV"), currentA: meanPower("currentA"), powerW: meanPower("powerW"),
        });
        this.patch({ samples: [...samples], progress: samples.length / sweepFrequencies.length });
      }
      this.audio.stop(); clearTimeout(this.deadline); this.patch({ playing: false, sweeping: false, message: "측정 결과를 분석하고 있습니다." });
      const result = await analyseSweep(samples, signal);
      if (!signal.aborted) this.patch({ result, resultMode: mode === "demo" ? "demo" : "device", message: "스윕 분석이 완료되었습니다." });
    } catch (error) {
      if (!signal.aborted) {
        this.audio.stop();
        this.patch({ playing: false, sweeping: false, message: this.error(error) });
      }
    } finally {
      this.collect = undefined; this.audio.stop(); clearTimeout(this.deadline);
      this.patch({ playing: false, sweeping: false, busy: false, sweepHz: null });
    }
  }

  exportResult() {
    if (!this.view.samples.length) return;
    const source = this.view.resultMode ?? (this.view.mode === "demo" ? "demo" : "device");
    const data = {
      recordedAt: new Date().toISOString(), source,
      hardware: "BNO085 + INA226 / ZK-502C 2-channel Bluetooth audio",
      settings: this.settings, stimulationArea: this.area, samples: this.view.samples, result: this.view.result,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "breath-sweep-" + source + "-" + Date.now() + ".json";
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async retryAnalysis() {
    if (this.view.busy || this.view.playing || this.view.samples.length !== sweepFrequencies.length) return;
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

  dispose() { this.disposed = true; this.disconnect(); void this.audio.dispose(); }
}
export { initialView, sweepFrequencies };
