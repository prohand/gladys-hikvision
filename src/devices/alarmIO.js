// -----------------------------------------------------------------------------
// Device type: ALARM I/O — the dry contacts of a camera or recorder, one
// Gladys device per Hikvision device that has any.
//
//   - input-<n>   alarm input n (a door contact, a PIR, a siren tamper…),
//                 1 while the contact is in alarm
//   - output-<n>  alarm output n (relay): a switch Gladys can drive
//
// Published only when the device has at least one input or output.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'alarm-io';

export function inputKey(id) {
  return `input-${Number(id)}`;
}

export function outputKey(id) {
  return `output-${Number(id)}`;
}

export function hasAlarmIo(station) {
  return station.io.inputs.length > 0 || station.io.outputs.length > 0;
}

export function deviceExternalId(gladys, station) {
  return gladys.externalIds(DEVICE_TYPE, station.info.serialNumber).device;
}

/** The discovery payload of a device's alarm contacts. */
export function buildAlarmIoDevice(gladys, station) {
  const ids = gladys.externalIds(DEVICE_TYPE, station.info.serialNumber);
  const features = [
    ...station.io.inputs.map((port) => ({
      name: port.name || `Alarm input ${port.id}`,
      external_id: ids.feature(inputKey(port.id)),
      category: DEVICE_FEATURE_CATEGORIES.INPUT,
      type: DEVICE_FEATURE_TYPES.INPUT.BINARY,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      min: 0,
      max: 1,
    })),
    ...station.io.outputs.map((port) => ({
      name: port.name || `Alarm output ${port.id}`,
      external_id: ids.feature(outputKey(port.id)),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      read_only: false,
      has_feedback: true,
      keep_history: true,
      min: 0,
      max: 1,
    })),
  ];
  return {
    name: `${station.info.deviceName} alarm I/O`,
    external_id: ids.device,
    params: [
      { name: 'host', value: station.label },
      { name: 'model', value: station.info.model },
      { name: 'serial_number', value: station.info.serialNumber },
    ],
    features,
  };
}

/** The states known for the contacts (read by the health check or the events). */
export function alarmIoStates(gladys, station) {
  const ids = gladys.externalIds(DEVICE_TYPE, station.info.serialNumber);
  const states = [];
  for (const [id, active] of station.ioState.inputs) {
    if (station.io.inputs.some((port) => port.id === id)) {
      states.push({ device_feature_external_id: ids.feature(inputKey(id)), state: active ? 1 : 0 });
    }
  }
  for (const [id, active] of station.ioState.outputs) {
    if (station.io.outputs.some((port) => port.id === id)) {
      states.push({
        device_feature_external_id: ids.feature(outputKey(id)),
        state: active ? 1 : 0,
      });
    }
  }
  return states;
}

/** A command from Gladys on an alarm output. */
export async function setAlarmIoValue(gladys, { station, featureKey, featureExternalId, value }) {
  const match = /^output-(\d+)$/.exec(featureKey);
  if (!match) {
    throw new Error(`Feature ${featureKey} cannot be changed`);
  }
  const on = Number(value) === 1;
  await station.setOutput(Number(match[1]), on);
  await gladys.publishState(featureExternalId, on ? 1 : 0);
}
