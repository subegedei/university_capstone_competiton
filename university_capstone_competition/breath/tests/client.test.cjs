require("./load-ts.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { BreathBleClient } = require("../lib/ble/client.ts");
const { BLE_INFO_UUID, BLE_CONTROL_UUID, BLE_TELEMETRY_UUID } = require("../lib/ble/protocol.ts");
const fixture = require("../docs/protocol-fixtures.json");

class Characteristic extends EventTarget {
  value;
  bytes = [];
  async startNotifications() {}
  emit(message) {
    const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n");
    this.emitBytes(bytes);
  }
  emitRaw(text) { this.emitBytes(new TextEncoder().encode(text)); }
  emitBytes(bytes) {
    for (let index = 0; index < bytes.length; index += 20) {
      const chunk = bytes.slice(index, index + 20);
      this.value = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.dispatchEvent(new Event("characteristicvaluechanged"));
    }
  }
}
function rig(accepted = true) {
  const telemetry = new Characteristic();
  const control = new Characteristic();
  let buffer = "";
  control.writeValueWithResponse = async (bytes) => {
    assert(bytes.length <= 20); control.bytes.push(bytes);
    buffer += new TextDecoder().decode(bytes);
    if (buffer.includes("\n")) {
      const command = JSON.parse(buffer.trim()); buffer = "";
      telemetry.emit({ ...fixture.ack, commandId: command.commandId, sessionId: command.sessionId, accepted });
    }
  };
  const info = { readValue: async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(fixture.info));
    return new DataView(bytes.buffer);
  } };
  const device = new EventTarget(); device.name = "BreathTokTok-ESP32";
  device.gatt = { connected: false, connect: async () => {
    device.gatt.connected = true;
    return { getPrimaryService: async () => ({ getCharacteristic: async (uuid) => ({ [BLE_INFO_UUID]: info, [BLE_CONTROL_UUID]: control, [BLE_TELEMETRY_UUID]: telemetry })[uuid] }) };
  }, disconnect: () => { device.gatt.connected = false; device.dispatchEvent(new Event("gattserverdisconnected")); } };
  Object.defineProperty(globalThis, "window", { value: { isSecureContext: true }, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { bluetooth: { requestDevice: async () => device } }, configurable: true });
  return { device, control, telemetry };
}
test("GATT handshake, ACK, duplicate telemetry filtering and reboot disconnect", async () => {
  const mock = rig();
  const client = new BreathBleClient(); const received = []; const errors = []; let disconnected = 0;
  try {
    assert.deepEqual(await client.connect((data) => received.push(data), () => disconnected++, (error) => errors.push(error)), fixture.info);
    await client.send(fixture.control);
    mock.telemetry.emit(fixture.telemetry); mock.telemetry.emit(fixture.telemetry);
    assert.equal(received.length, 1);
    mock.telemetry.emit({ ...fixture.telemetry, bootId: "boot-002", sequence: 0 });
    assert.equal(mock.device.gatt.connected, false);
    assert.equal(disconnected, 1);
    assert.match(errors[0], /재부팅/);
    await assert.rejects(client.send(fixture.control), /연결/);
  } finally { client.disconnect(); }
});
test("command rejection never becomes success", async () => {
  rig(false); const client = new BreathBleClient();
  try { await client.connect(() => {}, () => {}, () => {}); await assert.rejects(client.send(fixture.control), /거절/); }
  finally { client.disconnect(); }
});
test("a malformed telemetry line is skipped without dropping the BLE connection", async () => {
  const mock = rig(); const client = new BreathBleClient(); const received = []; const errors = []; let disconnected = 0;
  try {
    await client.connect((data) => received.push(data), () => disconnected++, (error) => errors.push(error));
    mock.telemetry.emitRaw('{"type":"telemetry","protocolVersion":3,"broken":true\n');
    assert.equal(mock.device.gatt.connected, true);
    assert.equal(disconnected, 0);
    assert.match(errors[0], /손상된 BLE 센서 프레임/);
    mock.telemetry.emit(fixture.telemetry);
    assert.equal(received.length, 1);
  } finally { client.disconnect(); }
});
