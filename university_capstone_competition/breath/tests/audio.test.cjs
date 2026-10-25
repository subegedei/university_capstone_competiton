require("./load-ts.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { TonePlayer } = require("../lib/audio/tone.ts");

class FakeContext extends EventTarget {
  state = "suspended"; currentTime = 0; destination = {}; stopTimes = []; values = [];
  async resume() { this.state = "running"; }
  createOscillator() { return { type: "", frequency: { setValueAtTime: value => this.values.push(["hz", value]) }, connect() {}, disconnect() {}, start() {}, stop: time => this.stopTimes.push(time) }; }
  createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime: value => this.values.push(["gain", value]), linearRampToValueAtTime: value => this.values.push(["gain", value]), cancelScheduledValues() {}, setTargetAtTime: value => this.values.push(["gain", value]) } }; }
  createStereoPanner() { return { connect() {}, disconnect() {}, pan: { setValueAtTime: value => this.values.push(["pan", value]) } }; }
  async close() { this.state = "closed"; }
}

test("tone uses the browser audio clock and stops when output is interrupted", async () => {
  let context; const original = globalThis.AudioContext;
  globalThis.AudioContext = class extends FakeContext { constructor() { super(); context = this; } };
  const player = new TonePlayer(); let interrupted = false; player.onInterrupted = () => interrupted = true;
  try {
    await player.prepare(); player.start(30, 20, 60, "both");
    assert(context.stopTimes.includes(60));
    assert(context.values.some(([key, value]) => key === "gain" && Math.abs(value - 0.07) < 1e-6));
    player.update(35, 40);
    assert(context.values.some(([key, value]) => key === "hz" && value === 35));
    context.state = "suspended"; context.dispatchEvent(new Event("statechange"));
    assert.equal(interrupted, true); assert.equal(context.values.at(-1)[1], 0);
  } finally { await player.dispose(); globalThis.AudioContext = original; }
});
