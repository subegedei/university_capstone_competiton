# ESP32 BLE JSON Protocol

## BLE characteristics

| Purpose | UUID | Direction |
| --- | --- | --- |
| Service | `f3f1a000-7c5b-4f18-b0bb-7d9cb9d00001` | — |
| Telemetry | `f3f1a001-7c5b-4f18-b0bb-7d9cb9d00001` | ESP32 → web, Notify |
| Control | `f3f1a002-7c5b-4f18-b0bb-7d9cb9d00001` | web → ESP32, Write |

The ESP32 advertises the service UUID. It should set an MTU of 247 or higher.
Keep one telemetry message below 180 UTF-8 bytes; if all four channels make
the payload larger, send one message per channel or use a compact field set.

## Control message

```json
{
  "type": "control",
  "command": "start",
  "frequencyHz": 27,
  "intensityPercent": 60,
  "durationSeconds": 600,
  "channels": [1, 2, 3, 4]
}
```

`command` is one of `start`, `stop`, `update`, or `sweep`. The ESP32 must
validate all values itself and must stop the output when BLE disconnects.

## Telemetry message

```json
{
  "type": "telemetry",
  "timestampMs": 1760000000000,
  "status": "running",
  "frequencyHz": 27,
  "intensityPercent": 60,
  "remainingSeconds": 588,
  "channels": [{"id": 1, "accelerationRms": 1.84, "piezoRms": 0.73}]
}
```

The browser renders the state acknowledged by ESP32, rather than assuming a
command succeeded. Send at 2–5 Hz during normal operation and at least once
immediately after every control command.
