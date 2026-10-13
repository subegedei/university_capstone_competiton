"use client";

import { useMemo, useRef, useState } from "react";
import { BreathBleClient } from "../lib/ble/client";
import { DeviceStatus, Telemetry, makeControlCommand } from "../lib/ble/protocol";

const DEFAULT_TELEMETRY: Telemetry = {
  type: "telemetry", timestampMs: 0, status: "idle", frequencyHz: 30,
  intensityPercent: 50, remainingSeconds: 600, channels: [],
};
const CHANNELS = [1, 2, 3, 4];

function displayTime(seconds: number) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  return `${mins}:${Math.max(0, seconds % 60).toString().padStart(2, "0")}`;
}

export default function Dashboard() {
  const client = useRef<BreathBleClient | null>(null);
  const [connectedName, setConnectedName] = useState<string>();
  const [frequencyHz, setFrequencyHz] = useState(30);
  const [intensity, setIntensity] = useState(50);
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [selectedChannels, setSelectedChannels] = useState(CHANNELS);
  const [telemetry, setTelemetry] = useState<Telemetry>(DEFAULT_TELEMETRY);
  const [message, setMessage] = useState("ESP32를 연결해 주세요.");

  const active = telemetry.status === "running";
  const controlSettings = useMemo(() => ({
    frequencyHz, intensityPercent: intensity, durationSeconds: durationMinutes * 60, channels: selectedChannels,
  }), [frequencyHz, intensity, durationMinutes, selectedChannels]);

  async function connect() {
    try {
      client.current ??= new BreathBleClient();
      const name = await client.current.connect(
        (next) => { setTelemetry(next); setMessage("실시간 센서 데이터를 수신하고 있습니다."); },
        () => { setConnectedName(undefined); setMessage("ESP32 연결이 해제되었습니다."); },
      );
      setConnectedName(name);
      setMessage(`${name}에 연결되었습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bluetooth 연결에 실패했습니다.");
    }
  }

  async function send(command: "start" | "stop" | "update" | "sweep") {
    try {
      await client.current?.send(makeControlCommand(command, controlSettings));
      setMessage(command === "stop" ? "정지 명령을 보냈습니다." : "ESP32로 제어 명령을 보냈습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "제어 명령을 보낼 수 없습니다.");
    }
  }

  function toggleChannel(id: number) {
    setSelectedChannels((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">BREATH TOK-TOK</p><h1>흉벽 진동 제어</h1></div>
        <button className={connectedName ? "connection connected" : "connection"} onClick={connect}>
          <span className="dot" />{connectedName ? connectedName : "ESP32 연결"}
        </button>
      </header>

      <section className="hero-card">
        <div><p className="eyebrow">ESTIMATED RESONANCE</p><h2>인체 흉벽 공진 주파수</h2><strong>{telemetry.frequencyHz || frequencyHz}<small> Hz</small></strong></div>
        <div className="status"><span className={`badge ${telemetry.status}`}>{statusText(telemetry.status)}</span><p>{message}</p></div>
      </section>

      <section className="layout">
        <article className="panel controls">
          <div className="panel-title"><h2>진동 제어</h2><button className="link" onClick={() => send("update")} disabled={!connectedName}>설정 전송</button></div>
          <Slider label="주파수" value={frequencyHz} unit="Hz" min={15} max={50} step={1} onChange={setFrequencyHz} />
          <Slider label="진동 강도" value={intensity} unit="%" min={0} max={100} step={5} onChange={setIntensity} />
          <Slider label="진동 시간" value={durationMinutes} unit="분" min={1} max={30} step={1} onChange={setDurationMinutes} />
          <div className="channels"><span>작동 패널</span><div>{CHANNELS.map((id) => <button key={id} onClick={() => toggleChannel(id)} className={selectedChannels.includes(id) ? "channel selected" : "channel"}>CH {id}</button>)}</div></div>
          <div className="actions"><button className="start" onClick={() => send("start")} disabled={!connectedName || !selectedChannels.length}>진동 시작</button><button className="stop" onClick={() => send("stop")} disabled={!connectedName}>정지</button></div>
        </article>

        <aside className="side-stack">
          <article className="panel live"><div className="panel-title"><h2>실시간 상태</h2><span>{connectedName ? "LIVE" : "OFFLINE"}</span></div>
            <Metric label="현재 진동수" value={`${telemetry.frequencyHz || "-"} Hz`} />
            <Metric label="진동 강도" value={`${telemetry.intensityPercent || "-"} %`} />
            <Metric label="남은 시간" value={telemetry.status === "idle" ? "--:--" : displayTime(telemetry.remainingSeconds)} />
          </article>
          <article className="panel sensor"><div className="panel-title"><h2>센서 데이터</h2><button className="link" onClick={() => send("sweep")} disabled={!connectedName}>스윕 측정</button></div>
            {telemetry.channels.length ? telemetry.channels.map((channel) => <div className="sensor-row" key={channel.id}><span>CH {channel.id}</span><b>가속도 {channel.accelerationRms?.toFixed(2) ?? "-"}</b><b>피에조 {channel.piezoRms?.toFixed(2) ?? "-"}</b></div>) : <p className="empty">ESP32에서 센서 JSON을 수신하면 이곳에 표시됩니다.</p>}
          </article>
        </aside>
      </section>
      <p className="footnote">주파수 스윕 결과는 Python 분석 API에서 계산하며, ESP32는 명령 수신 후 실제 상태를 telemetry로 회신합니다.</p>
    </main>
  );
}

function Slider({ label, value, unit, min, max, step, onChange }: { label: string; value: number; unit: string; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className="slider"><span>{label}<b>{value} {unit}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /><small>{min} {unit}<i>{max} {unit}</i></small></label>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><b>{value}</b></div>; }
function statusText(status: DeviceStatus) { return ({ idle: "대기", running: "진동 중", sweeping: "스윕 측정", error: "오류" })[status]; }
