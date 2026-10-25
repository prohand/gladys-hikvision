// -----------------------------------------------------------------------------
// Device type: CAMERA — one Gladys device per video channel (a camera has
// one, a recorder one per IP camera behind it).
//
// Features, depending on what the channel supports:
//   - image          the snapshot (camera image channel, never a state)
//   - enabled        Gladys-side privacy gate: off, Gladys stops showing the
//                    camera and the integration stops pushing its images and
//                    its detections. The camera itself keeps recording.
//   - motion         motion detected (VMD, or PIR) — always present
//   - line-crossing  smart line crossing detected
//   - intrusion      smart intrusion (field) detected
//   - tamper         video tampering detected
//   - <kind>-enabled switch turning that detection on or off on the camera
//   - ptz-move       PTZ movement step (pan / tilt / zoom)
//   - ptz-preset     go to a preset saved on the camera
//
// Feature keys are part of the external ids: never renamed.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'camera';

export const FEATURES = {
  IMAGE: 'image',
  ENABLED: 'enabled',
  MOTION: 'motion',
  LINE_CROSSING: 'line-crossing',
  INTRUSION: 'intrusion',
  TAMPER: 'tamper',
  PTZ_MOVE: 'ptz-move',
  PTZ_PRESET: 'ptz-preset',
};

/** Detection kind -> its binary sensor feature and its switch feature. */
export const DETECTION_FEATURES = {
  motion: { sensor: FEATURES.MOTION, toggle: 'motion-enabled', label: 'Motion' },
  line_crossing: {
    sensor: FEATURES.LINE_CROSSING,
    toggle: 'line-crossing-enabled',
    label: 'Line crossing',
  },
  intrusion: { sensor: FEATURES.INTRUSION, toggle: 'intrusion-enabled', label: 'Intrusion' },
  tamper: { sensor: FEATURES.TAMPER, toggle: 'tamper-enabled', label: 'Tampering' },
};

const MOVE_OPTIONS = [
  { value: 1, label: 'Pan left' },
  { value: 2, label: 'Pan right' },
  { value: 3, label: 'Tilt up' },
  { value: 4, label: 'Tilt down' },
  { value: 5, label: 'Zoom in' },
  { value: 6, label: 'Zoom out' },
];

const GENERIC_NAMES =
  /^(ip ?camera|network camera|ip dome|camera|embedded net dvr|network video recorder)$/i;

/** The platform id of a channel: serial number + channel, stable for life. */
export function platformId(station, channel) {
  return `${station.info.serialNumber}-${channel.id}`;
}

export function deviceExternalId(gladys, station, channel) {
  return gladys.externalIds(DEVICE_TYPE, platformId(station, channel)).device;
}

/** A name the user recognises: the channel's, or the camera's own. */
export function cameraName(station, channel) {
  const { deviceName, model } = station.info;
  if (station.recorder || station.channels.length > 1) {
    return channel.name || `${deviceName} ${channel.id}`;
  }
  if (deviceName && !GENERIC_NAMES.test(deviceName)) {
    return deviceName;
  }
  return channel.name && !/^camera ?0?1$/i.test(channel.name) ? channel.name : model || deviceName;
}

function binary(ids, key, name, category, type, readOnly) {
  return {
    name,
    external_id: ids.feature(key),
    category,
    type,
    read_only: readOnly,
    has_feedback: !readOnly,
    keep_history: true,
    min: 0,
    max: 1,
  };
}

/**
 * The discovery payload of one channel.
 * @param {object} gladys SDK client
 * @param {import('../hikvision/station.js').Station} station
 * @param {object} channel one of station.channels
 */
export function buildCameraDevice(gladys, station, channel) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformId(station, channel));
  const features = [
    {
      name: 'Image',
      external_id: ids.feature(FEATURES.IMAGE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
      read_only: true,
      has_feedback: false,
      // Images go through their own channel, never the states history.
      keep_history: false,
      min: 0,
      max: 0,
    },
    binary(
      ids,
      FEATURES.ENABLED,
      'Enabled in Gladys',
      DEVICE_FEATURE_CATEGORIES.CAMERA,
      DEVICE_FEATURE_TYPES.CAMERA.ENABLED,
      false,
    ),
  ];
  for (const [kind, { sensor, label }] of Object.entries(DETECTION_FEATURES)) {
    // Motion is always there: every Hikvision camera reports it, even when
    // the account cannot read the setting.
    if (kind !== 'motion' && !channel.detections[kind]) continue;
    features.push(
      binary(
        ids,
        sensor,
        label,
        kind === 'tamper'
          ? DEVICE_FEATURE_CATEGORIES.TAMPER
          : DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
        kind === 'tamper' ? DEVICE_FEATURE_TYPES.TAMPER.BINARY : DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        true,
      ),
    );
  }
  for (const [kind, { toggle, label }] of Object.entries(DETECTION_FEATURES)) {
    if (!channel.detections[kind]) continue;
    features.push(
      binary(
        ids,
        toggle,
        `${label} detection`,
        DEVICE_FEATURE_CATEGORIES.SWITCH,
        DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        false,
      ),
    );
  }
  if (channel.ptz) {
    features.push({
      name: 'PTZ',
      external_id: ids.feature(FEATURES.PTZ_MOVE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.MOVE,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: 6,
      supported_options: MOVE_OPTIONS.map((option, index) => ({ ...option, sort_order: index })),
    });
  }
  if (channel.ptz && channel.presets.length > 0) {
    features.push({
      name: 'Preset',
      external_id: ids.feature(FEATURES.PTZ_PRESET),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.PRESET,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      min: Math.min(...channel.presets.map((preset) => preset.id)),
      max: Math.max(...channel.presets.map((preset) => preset.id)),
      supported_options: channel.presets.map((preset, index) => ({
        value: preset.id,
        label: preset.name || `Preset ${preset.id}`,
        sort_order: index,
      })),
    });
  }
  return {
    name: cameraName(station, channel),
    external_id: ids.device,
    params: [
      { name: 'host', value: station.label },
      { name: 'model', value: station.info.model },
      { name: 'serial_number', value: station.info.serialNumber },
      { name: 'channel', value: String(channel.id) },
    ],
    features,
  };
}

/**
 * The state of the Gladys-side privacy gate: known without the camera, so
 * published even while it does not answer.
 * @returns {{ device_feature_external_id: string, state: number }}
 */
export function enabledState(gladys, station, channel, enabled) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformId(station, channel));
  return { device_feature_external_id: ids.feature(FEATURES.ENABLED), state: enabled ? 1 : 0 };
}

/**
 * The states read by a health check: detection switches.
 * @returns {{ device_feature_external_id: string, state: number }[]}
 */
export function cameraStates(gladys, station, channel) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformId(station, channel));
  return Object.entries(channel.detections).map(([kind, detection]) => ({
    device_feature_external_id: ids.feature(DETECTION_FEATURES[kind].toggle),
    state: detection.enabled ? 1 : 0,
  }));
}

/**
 * A command from Gladys on a camera feature.
 * @param {object} gladys SDK client
 * @param {{ station: object, channel: object, featureKey: string, featureExternalId: string, value: number }} command
 */
export async function setCameraValue(
  gladys,
  { station, channel, featureKey, featureExternalId, value },
) {
  if (featureKey === FEATURES.PTZ_MOVE) {
    await station.move(channel.id, Number(value));
    return;
  }
  if (featureKey === FEATURES.PTZ_PRESET) {
    await station.gotoPreset(channel.id, Number(value));
    return;
  }
  const kind = Object.keys(DETECTION_FEATURES).find(
    (candidate) => DETECTION_FEATURES[candidate].toggle === featureKey,
  );
  if (!kind) {
    throw new Error(`Feature ${featureKey} cannot be changed`);
  }
  const enabled = await station.setDetection(channel.id, kind, Number(value) === 1);
  // has_feedback: the camera accepted the setting, publish what it holds now.
  await gladys.publishState(featureExternalId, enabled ? 1 : 0);
}
