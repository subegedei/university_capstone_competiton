require("./load-ts.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { MeasurementSession } = require("../lib/session.ts");
const fixture = require("../docs/protocol-fixtures.json");
const settings = { frequencyHz: 30, intensityPercent: 20, durationSeconds: 60 };

class FakeAudioContext extends EventTarget {
  state = "suspended"; currentTime = 0; destination = {}; values = [];
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
  createOscillator() { return { type: "", frequency: { setValueAtTime: value => this.values.push(["hz", value]) }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
  createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime: value => this.values.push(["gain", value]), linearRampToValueAtTime: value => this.values.push(["gain", value]), cancelScheduledValues() {}, setTargetAtTime: value => this.values.push(["gain", value]) } }; }
  createStereoPanner() { return { connect() {}, disconnect() {}, pan: { setValueAtTime: value => this.values.push(["pan", value]) } }; }
}

function fake() {
  let callback; let disconnect;
  return { calls: [],
    async connect(next, down) { callback = next; disconnect = down; callback({ ...fixture.telemetry, status: "idle", sessionId: "" }); return fixture.info; },
    async send(command) { this.calls.push(command); },
    disconnect() { disconnect?.(); },
  };
}
function useFakeAudio() {
  let context;
  const original = globalThis.AudioContext;
  globalThis.AudioContext = class extends FakeAudioContext { constructor() { super(); context = this; } };
  return { get context() { return context; }, restore() { globalThis.AudioContext = original; } };
}

test("device starts Bluetooth audio locally and never sends an actuator command to ESP32", async () => {
  const audio = useFakeAudio(); const device = fake(); let view;
  const controller = new MeasurementSession(next => view = next, () => device);
  try {
    await controller.connect(false); await controller.start(settings, "both");
    assert.equal(view.playing, true);
    assert.equal(device.calls.length, 0);
    assert(audio.context.values.some(([key, value]) => key === "hz" && value === 30));
    await controller.update({ ...settings, frequencyHz: 35 });
    assert(audio.context.values.some(([key, value]) => key === "hz" && value === 35));
    await controller.stop(); assert.equal(view.playing, false);
  } finally { controller.dispose(); audio.restore(); }
});

test("demo never creates browser audio", async () => {
  const device = fake(); let view;
  const controller = new MeasurementSession(next => view = next, () => device);
  try {
    await controller.connect(true); await controller.start(settings, "both");
    assert.equal(view.playing, true); assert.equal(device.calls.length, 0);
    await controller.stop(); assert.equal(view.playing, false);
  } finally { controller.dispose(); }
});

test("ESP32 disconnect stops Bluetooth audio and clears sensor state", async () => {
  const audio = useFakeAudio(); const device = fake(); let view;
  const controller = new MeasurementSession(next => view = next, () => device);
  try {
    await controller.connect(false); await controller.start(settings, "both"); device.disconnect();
    assert.equal(view.mode, "offline"); assert.equal(view.playing, false); assert.equal(view.telemetry, null);
  } finally { controller.dispose(); audio.restore(); }
});

test("sensor failure prevents a local Bluetooth audio start", async () => {
  const audio = useFakeAudio(); const device = fake(); const connect = device.connect;
  device.connect = async (...args) => { const info = await connect(...args); return info; };
  let view; const controller = new MeasurementSession(next => view = next, () => device);
  try {
    await controller.connect(false);
    // The default fixture is ready; disconnecting removes fresh telemetry and blocks a new start.
    device.disconnect(); await controller.start(settings, "both");
    assert.equal(view.playing, false); assert.match(view.message, /최신 센서 데이터/);
  } finally { controller.dispose(); audio.restore(); }
});
