require("./load-ts.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { JsonLineDecoder, parseDeviceInfo, parseDeviceMessage, encodeCommand } = require("../lib/ble/protocol.ts");
const fixture = require("../docs/protocol-fixtures.json");

test("20-byte ATT chunks reassemble multiple NDJSON records, including split UTF-8", () => {
  const decoder = new JsonLineDecoder();
  const ack = { ...fixture.ack, error: "센서 상태 정상" };
  const wire = new TextEncoder().encode(JSON.stringify(ack) + "\n" + JSON.stringify(fixture.telemetry) + "\n");
  const messages = [];
  for (let offset = 0; offset < wire.length; offset += 7) messages.push(...decoder.push(wire.slice(offset, offset + 7)));
  assert.deepEqual(messages, [ack, fixture.telemetry]);
});
test("malformed, old-version and nonfinite telemetry are rejected", () => {
  assert.throws(() => parseDeviceMessage(JSON.stringify({ ...fixture.telemetry, protocolVersion: 1 })));
  assert.throws(() => parseDeviceMessage(JSON.stringify({ ...fixture.telemetry, imu: { ...fixture.telemetry.imu, accelerationRms: "1.2" } })));
  assert.throws(() => parseDeviceMessage(JSON.stringify({ ...fixture.telemetry, remainingSeconds: -1 })));
  assert.throws(() => parseDeviceMessage('{"type":"telemetry","protocolVersion":2,"sessionId":"","frequencyHz":1e999}'));
  assert.throws(() => new JsonLineDecoder().push(new TextEncoder().encode("x".repeat(8193))));
});
test("missing sensor values are null, while zero is a valid measurement", () => {
  const zero = { ...fixture.telemetry, imu: { ...fixture.telemetry.imu, accelerationRms: 0 }, power: { ...fixture.telemetry.power, currentA: 0, powerW: 0 } };
  assert.equal(parseDeviceMessage(JSON.stringify(zero)).power.currentA, 0);
  const missing = { ...zero, imu: { ready: false, linearAcceleration: null, accelerationRms: null, sampleCount: 0, sampleRateHz: 0 } };
  assert.equal(parseDeviceMessage(JSON.stringify(missing)).imu.accelerationRms, null);
});
test("device info rejects obsolete hardware and control enforces bounded durations", () => {
  assert.deepEqual(parseDeviceInfo(JSON.stringify(fixture.info)), fixture.info);
  assert.throws(() => parseDeviceInfo(JSON.stringify({ ...fixture.info, audioSource: "browser-bluetooth" })));
  const chunks = encodeCommand(fixture.control);
  assert(chunks.every((chunk) => chunk.length <= 20));
  assert.equal(new TextDecoder().decode(Buffer.concat(chunks)).endsWith("\n"), true);
  assert.throws(() => encodeCommand({ ...fixture.control, durationSeconds: 0 }));
  assert.throws(() => encodeCommand({ ...fixture.control, frequencyHz: 51 }));
});
test("v3 output capability and heartbeat are explicit", () => {
  assert.throws(() => parseDeviceInfo(JSON.stringify({ ...fixture.info, outputEnabled: undefined })));
  assert.throws(() => encodeCommand({ ...fixture.control, protocolVersion: 2 }));
  assert.throws(() => encodeCommand({ ...fixture.control, command: "unknown" }));
  assert.throws(() => encodeCommand({ ...fixture.control, sessionId: "x".repeat(65) }));
  assert(encodeCommand({ ...fixture.control, command: "heartbeat" }).length > 0);
});

