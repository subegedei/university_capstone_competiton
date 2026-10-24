/** Browser-generated audio is sent to the paired ZK-502C amplifier. */
type OutputMediaDevices = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
type RoutableContext = AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };
export type StimulationArea = "upper" | "lower" | "both";

/** The browser is the A2DP audio source. ESP32 is ONLY the BLE sensor/measurement controller. */
export class TonePlayer {
  private context?: RoutableContext;
  private oscillators: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private outputId = "";
  private stopTimer?: ReturnType<typeof setTimeout>;
  onInterrupted?: () => void;

  async selectOutput(): Promise<string> {
    const devices = navigator.mediaDevices as OutputMediaDevices | undefined;
    if (!devices?.selectAudioOutput) throw new Error("이 브라우저에서는 Windows 소리 설정에서 ZK-502C를 기본 출력으로 선택해 주세요.");
    const selected = await devices.selectAudioOutput();
    const context = this.getContext();
    if (!context.setSinkId) throw new Error("오디오 출력 선택을 지원하지 않습니다. Windows에서 기본 출력을 바꿔 주세요.");
    await context.setSinkId(selected.deviceId);
    this.outputId = selected.deviceId;
    return selected.label || "선택한 오디오 출력";
  }

  private getContext() {
    if (!this.context) {
      this.context = new AudioContext() as RoutableContext;
      this.context.addEventListener("statechange", () => {
        if (this.oscillators.length && this.context?.state !== "running") { this.stop(); this.onInterrupted?.(); }
      });
    }
    return this.context;
  }
  async prepare() {
    const context = this.getContext();
    if (this.outputId && context.setSinkId) await context.setSinkId(this.outputId);
    await context.resume();
    if (context.state !== "running") throw new Error("브라우저 오디오를 시작할 수 없습니다. 시작 버튼을 다시 눌러 주세요.");
  }
  start(hz: number, intensity: number, durationSeconds: number, area: StimulationArea) {
    this.stop();
    const context = this.getContext();
    if (context.state !== "running") throw new Error("오디오가 준비되지 않았습니다.");
    const pans = area === "upper" ? [-1] : area === "lower" ? [1] : [-1, 1];
    for (const panValue of pans) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(hz, context.currentTime);
      gain.gain.setValueAtTime(0, context.currentTime);
      // This is an application audio limit, not a calibrated actuator force.
      gain.gain.linearRampToValueAtTime(intensity / 100 * 0.35, context.currentTime + 0.04);
      panner.pan.setValueAtTime(panValue, context.currentTime);
      oscillator.connect(gain); gain.connect(panner); panner.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + durationSeconds);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); panner.disconnect(); };
      this.oscillators.push(oscillator); this.gains.push(gain);
    }
    this.stopTimer = setTimeout(() => this.stop(), durationSeconds * 1000);
  }
  update(hz: number, intensity: number) {
    if (!this.oscillators.length || !this.gains.length || !this.context || this.context.state !== "running") throw new Error("진동음이 중지되었습니다.");
    for (const oscillator of this.oscillators) oscillator.frequency.setValueAtTime(hz, this.context.currentTime);
    for (const gain of this.gains) {
      gain.gain.cancelScheduledValues(this.context.currentTime);
      gain.gain.setTargetAtTime(intensity / 100 * 0.35, this.context.currentTime, 0.015);
    }
  }
  stop() {
    clearTimeout(this.stopTimer); this.stopTimer = undefined;
    const oscillators = this.oscillators; this.oscillators = [];
    const gains = this.gains; this.gains = [];
    if (this.context) {
      for (const gain of gains) {
        gain.gain.cancelScheduledValues(this.context.currentTime);
        gain.gain.setValueAtTime(0, this.context.currentTime);
      }
    }
    for (const oscillator of oscillators) { try { oscillator.stop(); } catch { /* Already ended. */ } oscillator.disconnect(); }
  }
  async dispose() { this.stop(); const context = this.context; this.context = undefined; if (context && context.state !== "closed") await context.close(); }
}
