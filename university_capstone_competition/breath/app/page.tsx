"use client";

import { useEffect, useRef, useState } from "react";
import { MeasurementSession, SessionView, initialView } from "../lib/session";
import { SweepSample } from "../lib/analysis";
import { StimulationArea } from "../lib/audio/tone";

type SavedPreset = { name: string; frequency: number; intensity: number; minutes: number; area: StimulationArea };
const presetKey = "breath-toktok-presets-v1";
function isPreset(value: unknown): value is SavedPreset {
  if (!value || typeof value !== "object") return false;
  const preset = value as Record<string, unknown>;
  return typeof preset.name === "string" && typeof preset.frequency === "number" && typeof preset.intensity === "number" && typeof preset.minutes === "number" && (preset.area === "upper" || preset.area === "lower" || preset.area === "both");
}

function time(seconds: number) { const n = Math.max(0, Math.ceil(seconds)); return Math.floor(n / 60).toString().padStart(2, "0") + ":" + (n % 60).toString().padStart(2, "0"); }
function value(number: number | null | undefined, unit: string, digits = 2) { return number === null || number === undefined ? "—" : number.toFixed(digits) + " " + unit; }

export default function Dashboard() {
  const session = useRef<MeasurementSession | null>(null);
  const [view, setView] = useState<SessionView>(initialView);
  const [frequency, setFrequency] = useState(30);
  const [intensity, setIntensity] = useState(20);
  const [minutes, setMinutes] = useState(1);
  const [area, setArea] = useState<StimulationArea>("both");
  const [outputLabel, setOutputLabel] = useState("ZK-502C를 오디오 출력으로 선택");
  const [outputConfirmed, setOutputConfirmed] = useState(false);
  const [audioMessage, setAudioMessage] = useState("");
  const [audioBusy, setAudioBusy] = useState(false);
  const [presets, setPresets] = useState<Array<SavedPreset | null>>([null, null, null, null, null]);
  const [showConnect, setShowConnect] = useState(true);
  const [bleSupported, setBleSupported] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { setBleSupported(window.isSecureContext && !!navigator.bluetooth); }, []);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(presetKey);
      if (!saved) return;
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length === 5) setPresets(parsed.map((preset) => isPreset(preset) ? preset : null));
    } catch { /* A malformed local preset must not affect device controls. */ }
  }, []);
  useEffect(() => {
    if (showConnect && view.mode === "offline") dialog.current?.showModal();
    else dialog.current?.close();
  }, [showConnect, view.mode]);
  useEffect(() => {
    const controller = new MeasurementSession(setView); session.current = controller;
    const hidden = () => { if (document.hidden) { void controller.stop("화면을 벗어나 진동과 측정을 정지했습니다."); } };
    const unloaded = () => controller.dispose();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", unloaded);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", unloaded);
      controller.dispose(); session.current = null; };
  }, []);
  const settings = { frequencyHz: frequency, intensityPercent: intensity, durationSeconds: minutes * 60 };
  const telemetry = view.telemetry;
  const connected = view.mode !== "offline";
  const ready = connected && !!telemetry && telemetry.status !== "error" && telemetry.imu.ready && telemetry.power.ready && (view.mode === "demo" || outputConfirmed);
  const locked = view.busy || view.playing || audioBusy;

  async function selectOutput() {
    setAudioBusy(true);
    try {
      const label = await session.current?.selectOutput();
      if (label) { setOutputLabel(label); setOutputConfirmed(false); setAudioMessage("출력을 선택했습니다. ZK-502C의 시험음을 먼저 확인하세요."); }
    } catch (error) { setAudioMessage(error instanceof Error ? error.message : "오디오 출력을 선택할 수 없습니다."); }
    finally { setAudioBusy(false); }
  }
  async function testAudio() {
    setAudioBusy(true);
    try { await session.current?.testAudio(area); setAudioMessage("100 Hz · 10% 오디오 경로 시험음을 2초 동안 보냅니다."); }
    catch (error) { setAudioMessage(error instanceof Error ? error.message : "시험음 오류"); }
    finally { setTimeout(() => setAudioBusy(false), 2200); }
  }
  function savePreset(index: number) {
    const next = [...presets];
    next[index] = { name: `M${index + 1}`, frequency, intensity, minutes, area };
    setPresets(next);
    try { window.localStorage.setItem(presetKey, JSON.stringify(next)); } catch { /* Storage is optional. */ }
  }
  function applyPreset(preset: SavedPreset) {
    if (locked) return;
    setFrequency(preset.frequency); setIntensity(preset.intensity); setMinutes(preset.minutes); setArea(preset.area);
  }

  return <main className="shell" id="home">
    <a className="skip-link" href="#controls">진동 설정으로 바로가기</a>
    <dialog ref={dialog} className="connect-dialog" aria-labelledby="connect-title" onCancel={() => setShowConnect(false)}>
      <h2 id="connect-title">장치에 연결할까요?</h2>
      <p>확인을 누른 뒤 브라우저 목록에서 Breath-ESP32를 선택하세요. 연결만으로 진동이 시작되지는 않습니다.</p>
      {!bleSupported && <p className="warning">이 환경에서는 웹 Bluetooth를 사용할 수 없습니다. HTTPS의 Android Chrome 또는 컴퓨터 Chrome/Edge를 사용하세요. iPhone 기본 브라우저는 지원하지 않습니다.</p>}
      <p role="status">{view.message}</p>
      <div className="header-actions">
        <button className="start" disabled={!bleSupported || view.busy} onClick={() => void session.current?.connect(false)}>확인 · ESP32 선택</button>
        <button className="secondary" disabled={view.busy} onClick={() => setShowConnect(false)}>먼저 둘러보기</button>
      </div>
    </dialog>
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">🫁</span><div><p className="eyebrow">BREATH TOK-TOK</p><h1>숨결톡톡</h1><p className="subtitle">진동 제어 · 실시간 센서 모니터링</p></div></div>
      <div className="header-actions">
        {connected ? <button className="connection connected" disabled={view.busy && !view.playing} onClick={() => void session.current?.disconnect()}><span className="dot" />{view.mode === "demo" ? "데모 연결 해제" : "ESP32 연결 해제"}</button>
          : <><button className="connection" disabled={locked} onClick={() => void session.current?.connect(false)}>ESP32 연결</button>
            <button className="secondary" disabled={locked} onClick={() => void session.current?.connect(true)}>장치 없이 데모</button></>}
      </div>
    </header>

    <nav className="section-nav" aria-label="대시보드 바로가기">
      <a href="#home"><UiIcon kind="home" /><span>홈</span></a>
      <a href="#controls"><UiIcon kind="wave" /><span>진동 / 강도</span></a>
      <a href="#memory"><UiIcon kind="memory" /><span>메모리</span></a>
      <a href="#sensors"><UiIcon kind="sensor" /><span>센서</span></a>
      <a href="#sweep"><UiIcon kind="chart" /><span>스윕 분석</span></a>
    </nav>

    {view.mode === "demo" && <div className="demo-banner" role="status">데모 모드 · 센서값과 스윕 결과는 가상 데이터입니다. 실제 소리는 재생하지 않습니다.</div>}

    <section className="setup panel" id="connection" aria-labelledby="connection-heading">
      <div className="panel-title"><div className="heading-with-icon"><span className="icon-tile"><UiIcon kind="connection" /></span><div><p className="eyebrow">SYSTEM READY</p><h2 id="connection-heading">장치 연결 상태</h2></div></div><span className={outputConfirmed ? "tag good" : "tag"}>{outputConfirmed ? "출력 준비됨" : "출력 선택 필요"}</span></div>
      <p className="helper">ESP32는 센서값을 전송하고, 노트북 오디오 출력은 ZK-502C로 전달됩니다.</p>
      <div className="output-row"><span>{outputLabel}</span><button className="secondary" disabled={locked} onClick={() => void selectOutput()}>오디오 출력 선택</button></div>
      <label className="checkbox"><input type="checkbox" checked={outputConfirmed} disabled={locked} onChange={(event) => setOutputConfirmed(event.target.checked)} />ZK-502C 출력 준비를 확인했습니다.</label>
      {audioMessage && <p className="helper" role="status">{audioMessage}</p>}
    </section>

    <section className="hero-card">
      <div><p className="eyebrow">{view.resultMode === "demo" ? "DEMO RESPONSE PEAK" : "MEASURED RESPONSE PEAK"}</p><h2>측정 응답 피크 주파수</h2>
        <strong>{view.result ? view.result.estimatedResonanceHz : "—"}<small> Hz</small></strong><p className="hero-note">{view.result ? (view.resultMode === "demo" ? "가상 스윕 결과" : "장치·패널·접촉부를 포함한 시스템의 응답 피크") : "스윕 측정을 완료하면 표시됩니다."}</p></div>
      <div className="status"><span className={"badge " + (view.playing ? "running" : telemetry?.status === "error" ? "error" : "idle")}>{view.sweeping ? "스윕 측정 중" : view.playing ? (view.mode === "demo" ? "가상 진동 중" : "Bluetooth 진동음 재생 중") : "대기"}</span>
        <p aria-live="polite">{view.message}</p></div>
    </section>
    <p className="mobile-message" aria-live="polite">{view.message}</p>

    <section className="layout">
      <article className="panel controls" id="controls" aria-labelledby="controls-heading">
        <div className="panel-title"><div><p className="eyebrow">VIBRATION / INTENSITY</p><h2 id="controls-heading">진동 · 강도 설정</h2></div><button className="link" disabled={!view.playing || view.busy || view.sweeping} onClick={() => void session.current?.update(settings)}>설정 적용</button></div>
        <div className="setting-preview"><div><span className="preview-label">선택한 주파수</span><strong>{frequency}<small> Hz</small></strong><span className="preview-description">출력 레벨 {intensity}% · 설정 시간 {minutes}분</span></div><div className="wave-art" aria-hidden="true">{[18, 30, 52, 76, 44, 24, 54, 88, 64, 34, 18, 42, 64, 32, 18].map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}</div></div>
        <div className="channels" role="group" aria-label="진동 위치 선택"><span>진동 위치</span><div><button className={"channel " + (area === "upper" ? "selected" : "")} disabled={locked} onClick={() => setArea("upper")}>상엽</button><button className={"channel " + (area === "lower" ? "selected" : "")} disabled={locked} onClick={() => setArea("lower")}>하엽</button><button className={"channel " + (area === "both" ? "selected" : "")} disabled={locked} onClick={() => setArea("both")}>둘 다</button></div></div>
        <Slider label="주파수" value={frequency} unit="Hz" min={25} max={40} step={1} disabled={view.sweeping || view.busy} onChange={setFrequency} />
        <Slider label="출력 레벨" value={intensity} unit="%" min={0} max={100} step={5} disabled={view.sweeping || view.busy} onChange={setIntensity} />
        <Slider label="작동 시간" value={minutes} unit="분" min={1} max={30} step={1} disabled={view.playing || view.busy} onChange={setMinutes} />
        <p className="helper">상엽은 왼쪽 채널, 하엽은 오른쪽 채널로 보냅니다. 둘 다를 선택하면 양쪽에 같은 주파수를 보냅니다.</p>
        <div className="actions"><button className="start" disabled={!ready || locked || intensity === 0} onClick={() => void session.current?.start(settings, area)}><UiIcon kind="play" /><span>진동 시작<small>START</small></span></button>
          <button className="stop" disabled={!connected} onClick={() => { void session.current?.stop(); }}><UiIcon kind="stop" /><span>정지<small>STOP</small></span></button></div>
        <p className="helper">작동 중 주파수·출력 레벨을 바꾼 뒤 설정 적용을 누르세요. 종료 시각은 유지됩니다.</p>
      </article>

      <article className="panel memory" id="memory" aria-labelledby="memory-heading">
        <div className="panel-title"><div><p className="eyebrow">MEMORY PRESETS</p><h2 id="memory-heading">자주 쓰는 설정</h2></div><span className="tag">이 브라우저에 저장</span></div>
        <p className="helper">불러오기는 화면의 설정값만 바꾸며, 진동을 자동 시작하지 않습니다.</p>
        <div className="preset-grid">
          {presets.map((preset, index) => <div className={"preset " + (preset ? "saved" : "empty-preset")} key={index}>
            <strong>M{index + 1}</strong>
            {preset ? <><span>{preset.frequency} Hz · {preset.intensity}%</span><small>{preset.minutes}분 · {areaLabel(preset.area)}</small><div><button className="secondary" disabled={locked} onClick={() => applyPreset(preset)}>불러오기</button><button className="link" disabled={locked} onClick={() => savePreset(index)}>덮어쓰기</button></div></> : <><span>저장된 설정 없음</span><small>현재 설정을 보관할 수 있어요.</small><button className="secondary" disabled={locked} onClick={() => savePreset(index)}>현재 설정 저장</button></>}
          </div>)}
        </div>
      </article>

      <aside className="side-stack" id="sensors" aria-label="실시간 센서 상태">
        <article className="panel live"><div className="panel-title"><h2>실시간 상태</h2><span className="tag">{view.mode === "demo" ? "DEMO" : connected ? "BLE" : "OFFLINE"}</span></div>
          <Metric label="설정된 출력 주파수" text={view.playing ? value(frequency, "Hz", 0) : "—"} />
          <Metric label="설정된 출력 레벨" text={view.playing ? value(intensity, "%", 0) : "—"} />
          <Metric label="남은 시간" text={view.playing && telemetry ? time(telemetry.remainingSeconds) : "--:--"} />
          <Metric label="펌웨어" text={view.info?.firmwareVersion ?? "—"} />
        </article>
        <article className="panel sensor"><div className="panel-title"><h2>BNO085 · 선형 가속도</h2><span className={"tag " + (telemetry?.imu.ready ? "good" : "")}>{telemetry ? (telemetry.imu.ready ? "수신 중" : "센서 미준비") : "대기"}</span></div>
          <Metric label="진동 RMS" text={value(telemetry?.imu.ready ? telemetry.imu.accelerationRms : null, "m/s²", 3)} />
          <div className="axes"><span>X {value(telemetry?.imu.linearAcceleration?.x, "", 3)}</span><span>Y {value(telemetry?.imu.linearAcceleration?.y, "", 3)}</span><span>Z {value(telemetry?.imu.linearAcceleration?.z, "", 3)}</span></div>
          <p className="helper">샘플링 {value(telemetry?.imu.sampleRateHz, "Hz", 0)} · 윈도우 {telemetry?.imu.sampleCount ?? "—"}개</p>
        </article>
        <article className="panel sensor"><div className="panel-title"><h2>INA226 · 앰프 전원</h2><span className={"tag " + (telemetry?.power.ready && telemetry.power.calibrated ? "good" : "")}>{!telemetry ? "대기" : !telemetry.power.ready ? "센서 미준비" : telemetry.power.calibrated ? "보정 완료" : "전류 보정 필요"}</span></div>
          <Metric label="버스 전압" text={value(telemetry?.power.ready ? telemetry.power.busVoltageV : null, "V")} />
          <Metric label="전원 전류" text={value(telemetry?.power.ready && telemetry.power.calibrated ? telemetry.power.currentA : null, "A", 3)} />
          <Metric label="소비 전력" text={value(telemetry?.power.ready && telemetry.power.calibrated ? telemetry.power.powerW : null, "W")} />
          <p className="helper">앰프 전체 전원 측정값입니다. 액추에이터별 코일 전류는 아닙니다.</p>
        </article>
      </aside>
    </section>

    <section className="panel sweep" id="sweep" aria-labelledby="sweep-heading">
      {view.samples.length === 6 && !view.result && <button className="secondary" disabled={view.busy || view.playing} onClick={() => void session.current?.retryAnalysis()}>수집 데이터 다시 분석</button>}
      <div className="panel-title"><div><p className="eyebrow">FREQUENCY RESPONSE</p><h2 id="sweep-heading">주파수 스윕 · 20–45 Hz</h2></div><div className="header-actions"><button className="secondary" disabled={!view.samples.length || view.busy} onClick={() => session.current?.exportResult()}>결과 저장</button>
        <button className="start" disabled={!ready || locked || intensity === 0 || !telemetry?.imu.ready || telemetry.imu.sampleRateHz < 200} onClick={() => void session.current?.sweep(settings, area)}>스윕 측정</button></div></div>
      <p className="helper">20·25·30·35·40·45 Hz 여섯 구간을 측정합니다. 출력 레벨과 앰프 볼륨은 측정 중 유지하세요.</p>
      <div className="progress-label"><span>{view.sweeping ? view.sweepHz + " Hz 측정 중" : view.samples.length ? view.samples.length + " / 6 구간 수집" : "측정 대기"}</span><span>{Math.round(view.progress * 100)}%</span></div>
      <progress max={1} value={view.progress} aria-label="스윕 측정 진행률" />
      {view.samples.length > 0 ? <>
        <p className="helper chart-hint">그래프를 좌우로 밀면 전체 주파수 구간을 볼 수 있어요.</p>
        <div className="chart-scroll" role="region" aria-label="주파수 응답 그래프 · 좌우 스크롤 가능" tabIndex={0}>
          <ResponseChart samples={view.samples} />
        </div>
      </> : <ResponseChart samples={view.samples} />}
      {view.result && <div className="result"><span>피크 {view.result.estimatedResonanceHz} Hz</span><span>가속도 {view.result.peakAccelerationRms.toFixed(3)} m/s²</span><span>피크 대비 중앙값 차이 {(view.result.peakProminence * 100).toFixed(0)}%</span></div>}
      {view.result?.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
    </section>
    <footer className="dashboard-footer"><span>숨결톡톡 <small>BREATH TOK-TOK</small></span><p className="footnote">브라우저 오디오 또는 ESP32 센서 연결이 끊기면 진동음을 정지합니다. 스윕 피크는 장치·패널·접촉부를 포함한 모형 측정값이며 임상 효과를 뜻하지 않습니다.</p></footer>
  </main>;
}

function Slider({ label, value, unit, min, max, step, disabled, onChange }: { label: string; value: number; unit: string; min: number; max: number; step: number; disabled: boolean; onChange: (value: number) => void }) {
  return <div className="slider"><label><span>{label}<b>{value} {unit}</b></span><input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} style={{ "--range-fill": `${(value - min) / (max - min) * 100}%` } as React.CSSProperties} /><small>{min} {unit}<i>{max} {unit}</i></small></label><div className="stepper"><button type="button" aria-label={`${label} 줄이기`} disabled={disabled || value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</button><span>{step} {unit} 단위</span><button type="button" aria-label={`${label} 늘리기`} disabled={disabled || value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</button></div></div>;
}

function UiIcon({ kind }: { kind: "home" | "connection" | "wave" | "memory" | "sensor" | "chart" | "play" | "stop" }) {
  const paths = { home: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z", connection: "m8 7 9 10-5 4V3l5 4L8 17", wave: "M2 12c4-12 6 12 10 0s6 12 10 0", memory: "M5 3h14v18H5ZM8 7h8M8 11h8M8 15h5", sensor: "M3 12h4l3-8 4 16 3-8h4", chart: "M4 3v17h17M8 15l4-5 4 2 5-7", play: "m8 4 12 8-12 8Z", stop: "M5 5h14v14H5Z" };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
function Metric({ label, text }: { label: string; text: string }) { return <div className="metric"><span>{label}</span><b>{text}</b></div>; }
function areaLabel(area: StimulationArea) { return area === "upper" ? "상엽" : area === "lower" ? "하엽" : "둘 다"; }
function ResponseChart({ samples }: { samples: SweepSample[] }) {
  if (!samples.length) return <div className="chart-empty"><UiIcon kind="chart" /><strong>아직 측정한 데이터가 없어요</strong><span>스윕을 시작하면 주파수별 응답 곡선이 표시됩니다.</span><div className="frequency-markers" aria-hidden="true">{[20, 25, 30, 35, 40, 45].map(hz => <span key={hz}>{hz}<small> Hz</small></span>)}</div></div>;
  const maximum = Math.max(0.01, ...samples.map((sample) => sample.accelerationRms));
  const points = samples.map((sample) => (45 + (sample.hz - 20) / 25 * 680) + "," + (170 - sample.accelerationRms / maximum * 135)).join(" ");
  return <svg className="chart" viewBox="0 0 760 215" role="img" aria-label="주파수별 선형 가속도 RMS 응답 곡선">
    <title>20–45 Hz 선형 가속도 RMS</title><text x="12" y="18">m/s²</text><text x="12" y="40">{maximum.toFixed(2)}</text>
    <line x1="45" x2="725" y1="170" y2="170" stroke="var(--line)" /><line x1="45" x2="725" y1="100" y2="100" stroke="var(--line)" />
    <polyline points={points} fill="none" stroke="var(--blue)" strokeWidth="3" />
    {[20, 25, 30, 35, 40, 45].map((hz) => <text key={hz} x={45 + (hz - 20) / 25 * 680} y="195" textAnchor="middle">{hz}</text>)}<text x="743" y="195">Hz</text>
  </svg>;
}
