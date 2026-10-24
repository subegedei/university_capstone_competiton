require("./load-ts.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { MeasurementSession } = require("../lib/session.ts");
const fixture = require("../docs/protocol-fixtures.json");
const settings = { frequencyHz: 30, intensityPercent: 20, durationSeconds: 60 };
function fake() {
  let callback; let disconnect;
  return { calls: [], deferred: null,
    async connect(next, down) { callback = next; disconnect = down; callback({ ...fixture.telemetry, status: "idle", sessionId: "" }); return fixture.info; },
    async send(command) {
      this.calls.push(command);
      if (command.command === "start" && this.deferred) await this.deferred;
      callback({ ...fixture.telemetry, sessionId: command.sessionId, status: command.command === "stop" ? "idle" : command.command === "sweep" ? "sweeping" : "running" });
    },
    disconnect() { disconnect?.(); },
  };
}
test("demo start/update/stop keeps session and duration; no browser AudioContext required", async () => {
  const device = fake(); let view; const controller = new MeasurementSession((next) => view = next, () => device);
  try {
    await controller.connect(true); await controller.start(settings);
    assert.equal(view.playing, true);
    await controller.update({ ...settings, frequencyHz: 35 });
    assert.equal(device.calls[0].sessionId, device.calls[1].sessionId);
    await controller.stop();
    assert.equal(view.playing, false); assert.equal(view.busy, false);
    assert.equal(device.calls.at(-1).command, "stop");
  } finally { controller.dispose(); }
});
test("stop during outstanding start ACK prevents delayed playback and sends stop afterwards", async () => {
  const device = fake(); let release; device.deferred = new Promise((resolve) => release = resolve);
  let view; const controller = new MeasurementSession((next) => view = next, () => device);
  try {
    await controller.connect(true);
    const start = controller.start(settings);
    const stop = controller.stop();
    assert.equal(view.playing, false);
    release(); await Promise.all([start, stop]);
    assert.equal(view.playing, false);
    assert.deepEqual(device.calls.map((command) => command.command), ["start", "stop"]);
  } finally { controller.dispose(); }
});
test("disconnect during a session clears sensor state and never automatically resumes", async () => {
  const device = fake(); let view; const controller = new MeasurementSession((next) => view = next, () => device);
  try {
    await controller.connect(true); await controller.start(settings); device.disconnect();
    assert.equal(view.mode, "offline"); assert.equal(view.playing, false); assert.equal(view.telemetry, null);
  } finally { controller.dispose(); }
});
test("real-device control does not need browser audio", async () => {
  const device = fake(); let view;
  const controller = new MeasurementSession(next => view = next, () => device);
  try {
    await controller.connect(false); await controller.start(settings);
    assert.equal(view.playing, true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert(device.calls.some(c => c.command === "heartbeat"));
    await controller.stop();
  } finally { controller.dispose(); }
});
test("locked output prevents start and sweep", async () => {
  const device = fake(); const connect = device.connect;
  device.connect = async (...args) => ({ ...await connect(...args), outputEnabled: false });
  let view; const controller = new MeasurementSession(next => view = next, () => device);
  try {
    await controller.connect(false); await controller.start(settings);
    assert.equal(view.playing, false); assert.equal(device.calls.length, 0);
    assert.match(view.message, /잠겨/);
  } finally { controller.dispose(); }
});
test("failed stop is not presented as confirmed", async () => {
  const device = fake(); const send = device.send.bind(device); let view;
  device.send = async command => { if (command.command === "stop") throw new Error("lost ACK"); return send(command); };
  const controller = new MeasurementSession(next => view = next, () => device);
  try {
    await controller.connect(false); await controller.start(settings); await controller.stop();
    assert.equal(view.playing, false);
    assert.match(view.message, /정지 확인 실패/);
  } finally { controller.dispose(); }
});
test("locked sweep sends no actuator command", async () => {
  const device = fake(); const connect = device.connect;
  device.connect = async (...args) => ({ ...await connect(...args), outputEnabled: false });
  let view; const controller = new MeasurementSession(next => view = next, () => device);
  try {
    await controller.connect(false); await controller.sweep(settings);
    assert.equal(device.calls.length, 0);
    assert.match(view.message, /잠겨/);
  } finally { controller.dispose(); }
});


