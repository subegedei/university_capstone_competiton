"use client";

import { useEffect, useRef, useState } from "react";
import { MeasurementSession, SessionView, initialView } from "../lib/session";
import { SweepSample } from "../lib/analysis";
import { StimulationArea } from "../lib/audio/tone";

function time(seconds: number) { const n = Math.max(0, Math.ceil(seconds)); return Math.floor(n / 60).toString().padStart(2, "0") + ":" + (n % 60).toString().padStart(2, "0"); }
function value(number: number | null | undefined, unit: string, digits = 2) { return number === null || number === undefined ? "—" : number.toFixed(digits) + " " + unit; }

export default function Dashboard() {
  const session = useRef<MeasurementSession | null>(null);
  const [view, setView] = useState<SessionView>(initialView);
  const [frequency, setFrequency] = useState(30);
  const [intensity, setIntensity] = useState(20);
  const [minutes, setMinutes] = useState(1);
  const [area, setArea] = useState<StimulationArea>("both");
  const [outputLabel, setOutputLabel] = useState("기본 오디오 출력");
  const [outputConfirmed, setOutputConfirmed] = useState(false);
  const [audioMessage, setAudioMessage] = useState("");
  const [audioBusy, setAudioBusy] = useState(false);
  const [showConnect, setShowConnect] = useState(true);
  const [bleSupported, setBleSupported] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { setBleSupported(window.isSecureContext && !!navigator.bluetooth); }, []);
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
      if (label) { setOutputLabel(label); setOutputConfirmed(false); setAudioMessage("오디오 출력을 선택했습니다. 앰프에서 출력되는지 확인하세요."); }
    } catch (error) {
      setAudioMessage(error instanceof Error ? error.message : "오디오 출력을 선택할 수 없습니다.");
    } finally { setAudioBusy(false); }
  }
  async function testAudio() {
    setAudioBusy(true);
    try {
      await session.current?.testAudio(area);
      setAudioMessage("30 Hz · 5% 테스트음을 2초 동안 보냅니다.");
    } catch (error) {
      setAudioMessage(error instanceof Error ? error.message : "테스트음 오류");
    } finally { setTimeout(() => setAudioBusy(false), 2200); }
  }

  return <main className="shell">
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
      <div><p className="eyebrow">BREATH TOK-TOK</p><h1>숨결톡톡 제어 대시보드</h1><p className="subtitle">Bluetooth 2채널 진동 + BNO085 · INA226 센서</p></div>
      <div className="header-actions">
        {connected ? <button className="connection connected" disabled={view.busy && !view.playing} onClick={() => session.current?.disconnect()}><span className="dot" />{view.mode === "demo" ? "데모 연결 해제" : "ESP32 연결 해제"}</button>
          : <><button className="connection" disabled={locked} onClick={() => void session.current?.connect(false)}>ESP32 연결</button>
            <button className="secondary" disabled={locked} onClick={() => void session.current?.connect(true)}>장치 없이 데모</button></>}
      </div>
    </header>

    {view.mode === "demo" && <div className="demo-banner" role="status">데모 모드 · 센서값과 스윕 결과는 가상 데이터입니다. 실제 소리는 재생하지 않습니다.</div>}

    <section className="setup panel">
      <div className="panel-title"><h2>ZK-502C 오디오 연결</h2><span className={outputConfirmed ? "tag good" : "tag"}>{outputConfirmed ? "출력 확인 완료" : "출력 확인 필요"}</span></div>
      <p className="helper">휴대폰/노트북 Bluetooth 오디오 → ZK-502C 앰프 → 상엽·하엽 진동자. ESP32는 BNO085·INA226 값을 BLE로 보냅니다.</p>
      <div className="output-row"><span>{outputLabel}</span><button className="secondary" disabled={locked} onClick={() => void selectOutput()}>오디오 출력 선택</button><button className="secondary" disabled={locked || !outputConfirmed || view.mode === "demo"} onClick={() => void testAudio()}>2초 테스트음</button></div>
      <label className="checkbox"><input type="checkbox" checked={outputConfirmed} disabled={locked} onChange={(event) => setOutputConfirmed(event.target.checked)} />ZK-502C가 현재 Bluetooth 오디오 출력이며 실제 진동을 확인했습니다.</label>
      {audioMessage && <p className="helper" role="status">{audioMessage}</p>}
      <p className="warning">앰프의 실제 볼륨과 액추에이터 상태에 따라 진동 세기가 달라집니다. 화면의 %는 안전한 실제 힘을 보장하지 않습니다.</p>
    </section>

    <section className="hero-card">
      <div><p className="eyebrow">{view.resultMode === "demo" ? "DEMO RESPONSE PEAK" : "MEASURED RESPONSE PEAK"}</p><h2>측정 응답 피크 주파수</h2>
        <strong>{view.result ? view.result.estimatedResonanceHz : "—"}<small> Hz</small></strong><p className="hero-note">{view.result ? (view.resultMode === "demo" ? "가상 스윕 결과" : "장치·패널·접촉부를 포함한 시스템의 응답 피크") : "스윕 측정을 완료하면 표시됩니다."}</p></div>
      <div className="status"><span className={"badge " + (view.playing ? "running" : telemetry?.status === "error" ? "error" : "idle")}>{view.sweeping ? "스윕 측정 중" : view.playing ? (view.mode === "demo" ? "가상 진동 중" : "Bluetooth 진동음 재생 중") : "대기"}</span>
        <p aria-live="polite">{view.message}</p></div>
    </section>
    <p className="mobile-message" aria-live="polite">{view.message}</p>

    <section className="layout">
      <article className="panel controls">
        <div className="panel-title"><h2>상엽 · 하엽 진동 출력</h2><button className="link" disabled={!view.playing || view.busy || view.sweeping} onClick={() => void session.current?.update(settings)}>설정 적용</button></div>
        <div className="channels" role="group" aria-label="진동 위치 선택"><span>진동 위치</span><div><button className={"channel " + (area === "upper" ? "selected" : "")} disabled={locked} onClick={() => setArea("upper")}>상엽</button><button className={"channel " + (area === "lower" ? "selected" : "")} disabled={locked} onClick={() => setArea("lower")}>하엽</button><button className={"channel " + (area === "both" ? "selected" : "")} disabled={locked} onClick={() => setArea("both")}>둘 다</button></div></div>
        <Slider label="주파수" value={frequency} unit="Hz" min={25} max={40} step={1} disabled={view.sweeping || view.busy} onChange={setFrequency} />
        <Slider label="출력 레벨" value={intensity} unit="%" min={0} max={100} step={5} disabled={view.sweeping || view.busy} onChange={setIntensity} />
        <Slider label="작동 시간" value={minutes} unit="분" min={1} max={30} step={1} disabled={view.playing || view.busy} onChange={setMinutes} />
        <p className="helper">상엽은 왼쪽 채널, 하엽은 오른쪽 채널로 보냅니다. 둘 다를 선택하면 양쪽 채널에 같은 주파수를 보냅니다.</p>
        <div className="actions"><button className="start" disabled={!ready || locked || intensity === 0} onClick={() => void session.current?.start(settings, area)}>진동 시작</button>
          <button className="stop" disabled={!connected} onClick={() => { void session.current?.stop(); }}>정지</button></div>
        <p className="helper">작동 중 주파수·출력 레벨을 바꾼 뒤 설정 적용을 누르세요. 종료 시각은 유지됩니다.</p>
      </article>

      <aside className="side-stack">
        <article className="panel live"><div className="panel-title"><h2>실시간 상태</h2><span className="tag">{view.mode === "demo" ? "DEMO" : connected ? "BLE" : "OFFLINE"}</span></div>
          <Metric label="현재 측정 주파수" text={value(telemetry?.frequencyHz, "Hz", 0)} />
          <Metric label="현재 출력 레벨" text={value(telemetry?.intensityPercent, "%", 0)} />
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

    <section className="panel sweep">
      {view.samples.length === 6 && !view.result && <button className="secondary" disabled={view.busy || view.playing} onClick={() => void session.current?.retryAnalysis()}>수집 데이터 다시 분석</button>}
      <div className="panel-title"><h2>주파수 스윕 · 20–45 Hz</h2><div className="header-actions"><button className="secondary" disabled={!view.samples.length || view.busy} onClick={() => session.current?.exportResult()}>결과 저장</button>
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
    <p className="footnote">화면을 벗어나거나 ESP32 센서 수신이 끊기면 브라우저 오디오를 정지합니다. 스윕 피크는 장치·패널·접촉부를 포함한 모형 측정값이며 임상 효과를 뜻하지 않습니다.</p>
  </main>;
}

function Slider({ label, value, unit, min, max, step, disabled, onChange }: { label: string; value: number; unit: string; min: number; max: number; step: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label className="slider"><span>{label}<b>{value} {unit}</b></span><input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /><small>{min} {unit}<i>{max} {unit}</i></small></label>;
}
function Metric({ label, text }: { label: string; text: string }) { return <div className="metric"><span>{label}</span><b>{text}</b></div>; }
function ResponseChart({ samples }: { samples: SweepSample[] }) {
  if (!samples.length) return <div className="chart-empty">측정이 시작되면 주파수별 응답 곡선이 표시됩니다.</div>;
  const maximum = Math.max(0.01, ...samples.map((sample) => sample.accelerationRms));
  const points = samples.map((sample) => (45 + (sample.hz - 20) / 25 * 680) + "," + (170 - sample.accelerationRms / maximum * 135)).join(" ");
  return <svg className="chart" viewBox="0 0 760 215" role="img" aria-label="주파수별 선형 가속도 RMS 응답 곡선">
    <title>20–45 Hz 선형 가속도 RMS</title><text x="12" y="18">m/s²</text><text x="12" y="40">{maximum.toFixed(2)}</text>
    <line x1="45" x2="725" y1="170" y2="170" stroke="#dce7f0" /><line x1="45" x2="725" y1="100" y2="100" stroke="#edf2f7" />
    <polyline points={points} fill="none" stroke="#1868cf" strokeWidth="3" />
    {[20, 25, 30, 35, 40, 45].map((hz) => <text key={hz} x={45 + (hz - 20) / 25 * 680} y="195" textAnchor="middle">{hz}</text>)}<text x="743" y="195">Hz</text>
  </svg>;
}
