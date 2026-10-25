# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and to human contributors working in
this repository.

## What this is

A Gladys Assistant **external integration** (Node 22+, ESM, no build step, one runtime
dependency: `@gladysassistant/integration-sdk`) for **Hikvision IP cameras and recorders
(NVR/DVR)**, over their **local ISAPI** only (manifest `transports: ["local"]`, no Hik-Connect).
It started from the official template (GladysAssistant/integration-template-js); its workflows are
the ones of prohand/gladys-devmel.

Gladys gets: one device per camera channel (image, the Gladys-side `enabled` privacy gate,
detections as binary sensors, detection switches, PTZ move and presets), one "alarm I/O" device per Hikvision device with dry contacts,
scene triggers (`event_detected`, `camera_offline`, `camera_online`), scene actions
(`take_snapshot`, `set_detection`, `goto_preset`), the `hikvision` widget and the
`test_connection` action.

## Commands

```bash
npm install
npm test                                   # node --test (built-in runner)
node --test test/index.test.js             # one file
node --test --test-name-pattern "PTZ"      # tests whose name matches
npm run lint                               # eslint .
npm run format:check                       # prettier --check . (CI gate)
npm run format                             # prettier --write .
npx github:GladysAssistant/integration-store .   # store admission checks
```

CI runs `format:check`, `lint`, `test` on Node 22 and 24: run the three before pushing.

## Architecture

```
index.js                   SDK wiring only, register(gladys, deps) exported for the tests
src/hub.js                 stations <-> Gladys (devices, states, images, events, badges, status)
src/hikvision/client.js    HTTP client on node:http/https, Digest auth, IsapiError codes
src/hikvision/digest.js    RFC 7616 Digest + Basic fallback
src/hikvision/isapi.js     one function per ISAPI call
src/hikvision/alertStream.js  long-lived alert stream, idle watchdog, reconnection
src/hikvision/events.js    alert parser, event keys, DetectionTracker (one transition per detection)
src/hikvision/station.js   one device at one address: discover, refresh, commands, stream
src/devices/               camera.js and alarmIO.js: discovery payloads + commands
src/capabilities/          scenes.js (actions + trigger keys) and widget.js
src/connection.js          "Test the connection" report
src/messages.js, i18n.js   user-facing texts { en, fr, de, es }
src/config.js              DEFAULT_CONFIG (mirrors the manifest) + normalization
src/store.js               last discovery per address, in /data/stations.json
test/helpers/fakeHikvision.js  fake device on the loopback (real Digest, scripted alert stream)
```

## Invariants worth knowing

- **External ids are forever.** Camera: `externalIds('camera', '<serial>-<channel>')`; alarm I/O:
  `externalIds('alarm-io', '<serial>')`. Feature keys (`enabled`, `motion`, `line-crossing`,
  `intrusion`, `tamper`, `<kind>-enabled`, `ptz-move`, `ptz-preset`, `input-<n>`, `output-<n>`), trigger,
  action, widget, config keys and the `event_type` option values are stored by users: never rename.
- **A camera disabled in Gladys** (`enabled` = 0, kept in `/data/disabled-cameras.json` by
  platform id) gets no image (periodic, on demand, widget, scene action) and its detections fire
  neither a state nor a scene event. Its detection switches, PTZ and alarm contacts still work.
- **A wrong password costs ONE failed login, never more.** Hikvision locks the account (or the
  client IP) after a few failures, and a lock looks like a wrong password. `client.js` retries a
  401 only when no credentials were sent yet or the cached nonce expired; after an `auth` /
  `locked` error the station is `authBlocked`: no timer, no stream reconnect retries it. Only a
  configuration save or the `test_connection` action does.
- **Nothing is guessed from model names.** A recorder is a device that answers
  `/ISAPI/ContentMgmt/InputProxy/channels`; PTZ is a channel that answers `.../capabilities`;
  detection paths are probed (`detectionPaths`, recorder proxy path first).
- **Detection switches are read-modify-write**: GET the setting, replace the FIRST `<enabled>`,
  PUT it back. Zones, sensitivity and schedules go back untouched.
- **One scene event per transition.** Cameras repeat `active` alerts every second and often never
  send `inactive`: `DetectionTracker` holds a detection `event_hold` seconds after the last alert.
  The `videoloss`/`inactive` alert is the stream heartbeat, never an event.
- **Images ≤ 150 KB** (Gladys limit): sub-stream by default; main stream asked at 1280×720, then
  the sub-stream. Periodic snapshots only for devices the user created, ≤ 12/min per camera
  (`snapshot_interval` ≥ 10 s).
- **PTZ moves are bounded**: a momentary step the camera stops by itself, else a continuous move
  with a stop timer (the watchdog). `Station.close()` stops any move still running.
- **Polling**: Gladys `should_poll` is not used; each station has its own timer
  (`refresh_interval`, seconds). Never publish a `poll_frequency` that is not in
  `DEVICE_POLL_FREQUENCIES` (milliseconds).
- **Every feature declares `min`/`max`** (NOT NULL in Gladys).
- **The rootfs is read-only**: write only under `/data` (`DATA_DIR`). Never log a password; never
  accept credentials inside an address (`parseHost` refuses them and never echoes them).
- **Transport badge**: `local` when the channel answers, `unreachable` otherwise, `degraded` when
  the alert stream is down.

## Rules

- **Versions belong to the Release workflow** (Actions → Release). Never edit `version` in
  `package.json` or the manifest, nor the `docker_image` tag, by hand. `test/manifest.test.js`
  checks they agree.
- **Changelog**: every user-visible change adds a line under `## [Unreleased]` in `CHANGELOG.md`
  (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`). Never write a version heading.
- **Manifest**: every text is `{ en, fr, de, es }`; the catalog `description` is 10–100 characters
  per language; `gladys_version` stays `>=5.3.0` or higher (widgets, scene triggers / actions:
  5.1; `keywords`: 5.3).
  `test/manifest.test.js` ties the manifest to the code: change both sides together.
- **User-facing text** (action answers, statuses, widget, docs) is written in the four languages;
  `docs/en.md`, `docs/fr.md`, `docs/de.md`, `docs/es.md` are kept in sync.
- **Style**: Prettier formats, ESLint catches mistakes. Comments explain why, in English. Tests
  never touch the network (loopback fake device only).
