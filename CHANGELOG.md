# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [0.0.2] - 2026-10-23

- Maintenance release, no functional change.

## [0.0.1] - 2026-10-14

### Added

- Hikvision cameras and recorders (NVR / DVR) over their local ISAPI, with Digest authentication, HTTP or HTTPS, several devices at once.
- One Gladys device per camera: image, motion, line crossing, intrusion and tampering detections, switches to arm or disarm each detection on the camera, PTZ moves and presets.
- One "alarm I/O" device per camera or recorder with dry contacts: alarm inputs and alarm outputs (relays, sirens).
- Real-time detections from the device's event stream, one scene event per detection.
- Camera images pushed periodically and captured on demand, always under the 150 KB Gladys accepts.
- Scene triggers: a camera detects something (filters: camera, event, person / vehicle), a camera goes offline, a camera is back online.
- Scene actions: take a snapshot, arm or disarm a detection, move a PTZ camera to a preset.
- "Hikvision" dashboard widget: cameras online, detections of the last 24 hours, live image, last detection per camera, Snapshot / Disarm / Arm buttons.
- "Test the connection" button explaining what each device gives Gladys, or what to fix.
- Local transport badge per device, degraded when the event stream is down.
- English, French, German and Spanish for the configuration screen, the messages, the widget and the documentation.

### Security

- A refused password is never retried automatically, so the integration cannot lock the account on the device.

[Unreleased]: https://github.com/prohand/gladys-hikvision/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/prohand/gladys-hikvision/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/prohand/gladys-hikvision/releases/tag/v0.0.1
