// -----------------------------------------------------------------------------
// The ISAPI calls the integration makes, one function per question asked to
// the device. Every function takes an IsapiClient and returns plain data.
//
// Cameras and recorders (NVR/DVR) speak the same ISAPI, with two differences
// that matter here: a recorder lists its cameras under InputProxy, and it
// relays PTZ and detection settings through proxy paths. Nothing is guessed
// from the model name: the device is asked, and what answers decides.
// -----------------------------------------------------------------------------

import { IsapiError } from './client.js';
import { readBlocks, readBoolean, readTag, replaceFirstTag } from './xml.js';

/** Gladys refuses camera images over 150 KB. */
export const MAX_IMAGE_BYTES = 150 * 1024;

/**
 * Identity of the device.
 * @param {import('./client.js').IsapiClient} client
 */
export async function getDeviceInfo(client) {
  const xml = await client.text('GET', '/ISAPI/System/deviceInfo');
  const serialNumber = readTag(xml, 'serialNumber');
  if (!serialNumber) {
    throw new IsapiError('http', `${client.label}: deviceInfo without a serial number`);
  }
  return {
    deviceName: readTag(xml, 'deviceName') || readTag(xml, 'model') || client.label,
    model: readTag(xml, 'model') ?? '',
    serialNumber,
    macAddress: readTag(xml, 'macAddress') ?? '',
    firmwareVersion: [readTag(xml, 'firmwareVersion'), readTag(xml, 'firmwareReleasedDate')]
      .filter(Boolean)
      .join(' '),
    deviceType: readTag(xml, 'deviceType') ?? '',
  };
}

/**
 * The video channels of the device.
 *
 * A recorder answers InputProxy with its IP cameras; a camera does not know
 * that path (404 / notSupport) and lists its own video inputs. A device that
 * answers neither still has a channel 1.
 *
 * @returns {Promise<{ recorder: boolean, channels: { id: number, name: string }[] }>}
 */
export async function getChannels(client) {
  try {
    const xml = await client.text('GET', '/ISAPI/ContentMgmt/InputProxy/channels');
    const channels = readBlocks(xml, 'InputProxyChannel')
      .map((block) => ({ id: Number(readTag(block, 'id')), name: readTag(block, 'name') ?? '' }))
      .filter((channel) => Number.isInteger(channel.id) && channel.id > 0);
    if (channels.length > 0) {
      return { recorder: true, channels };
    }
  } catch (error) {
    rethrowConnectionError(error);
  }
  try {
    const xml = await client.text('GET', '/ISAPI/System/Video/inputs/channels');
    const channels = readBlocks(xml, 'VideoInputChannel')
      .map((block) => ({ id: Number(readTag(block, 'id')), name: readTag(block, 'name') ?? '' }))
      .filter((channel) => Number.isInteger(channel.id) && channel.id > 0);
    if (channels.length > 0) {
      return { recorder: false, channels };
    }
  } catch (error) {
    rethrowConnectionError(error);
  }
  return { recorder: false, channels: [{ id: 1, name: '' }] };
}

/**
 * Online state of each IP camera behind a recorder.
 * @returns {Promise<Map<number, boolean>>} empty when the recorder does not say
 */
export async function getChannelsStatus(client) {
  const status = new Map();
  try {
    const xml = await client.text('GET', '/ISAPI/ContentMgmt/InputProxy/channels/status');
    for (const block of readBlocks(xml, 'InputProxyChannelStatus')) {
      const id = Number(readTag(block, 'id'));
      const online = readBoolean(block, 'online');
      if (Number.isInteger(id) && online !== undefined) {
        status.set(id, online);
      }
    }
  } catch (error) {
    rethrowConnectionError(error);
  }
  return status;
}

/**
 * The alarm inputs and outputs (dry contacts) of the device.
 * @returns {Promise<{ inputs: { id: number, name: string }[], outputs: { id: number, name: string }[] }>}
 */
export async function getIoPorts(client) {
  const read = async (path, block) => {
    try {
      const xml = await client.text('GET', path);
      return readBlocks(xml, block)
        .map((entry) => ({ id: Number(readTag(entry, 'id')), name: readTag(entry, 'name') ?? '' }))
        .filter((port) => Number.isInteger(port.id) && port.id > 0);
    } catch (error) {
      rethrowConnectionError(error);
      return [];
    }
  };
  return {
    inputs: await read('/ISAPI/System/IO/inputs', 'IOInputPort'),
    outputs: await read('/ISAPI/System/IO/outputs', 'IOOutputPort'),
  };
}

/**
 * State of every alarm input and output, `true` when active.
 * @returns {Promise<{ inputs: Map<number, boolean>, outputs: Map<number, boolean> }>}
 */
export async function getIoStatus(client) {
  const inputs = new Map();
  const outputs = new Map();
  try {
    const xml = await client.text('GET', '/ISAPI/System/IO/status');
    for (const block of readBlocks(xml, 'IOPortStatus')) {
      const id = Number(readTag(block, 'ioPortID'));
      const type = readTag(block, 'ioPortType')?.toLowerCase();
      const state = readTag(block, 'ioState')?.toLowerCase();
      if (!Number.isInteger(id) || !state) {
        continue;
      }
      (type === 'output' ? outputs : inputs).set(id, state === 'active');
    }
  } catch (error) {
    rethrowConnectionError(error);
  }
  return { inputs, outputs };
}

/** Switch an alarm output (relay) on or off. */
export async function setOutput(client, id, on) {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<IOPortData version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">' +
    `<outputState>${on ? 'high' : 'low'}</outputState></IOPortData>`;
  await client.text('PUT', `/ISAPI/System/IO/outputs/${Number(id)}/trigger`, { body });
}

/** Base path of the PTZ commands: direct on a camera, relayed by a recorder. */
export function ptzBase(recorder) {
  return recorder ? '/ISAPI/ContentMgmt/PTZCtrlProxy/channels' : '/ISAPI/PTZCtrl/channels';
}

/**
 * The PTZ presets saved on a channel; null when the channel has no PTZ.
 * @returns {Promise<{ id: number, name: string }[] | null>}
 */
export async function getPresets(client, recorder, channel) {
  try {
    const xml = await client.text('GET', `${ptzBase(recorder)}/${Number(channel)}/presets`);
    return readBlocks(xml, 'PTZPreset')
      .filter((block) => readBoolean(block, 'enabled') !== false)
      .map((block) => ({
        id: Number(readTag(block, 'id')),
        name: readTag(block, 'presetName') ?? '',
      }))
      .filter((preset) => Number.isInteger(preset.id) && preset.id > 0);
  } catch (error) {
    rethrowConnectionError(error);
    return null;
  }
}

/** Send a PTZ channel to one of its saved presets. */
export async function gotoPreset(client, recorder, channel, presetId) {
  await client.text(
    'PUT',
    `${ptzBase(recorder)}/${Number(channel)}/presets/${Number(presetId)}/goto`,
    { body: '' },
  );
}

/**
 * Start (or stop, all at 0) a continuous PTZ movement. Speeds from -100 to 100.
 */
export async function continuousMove(client, recorder, channel, { pan = 0, tilt = 0, zoom = 0 }) {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<PTZData version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">' +
    `<pan>${Math.round(pan)}</pan><tilt>${Math.round(tilt)}</tilt><zoom>${Math.round(zoom)}</zoom>` +
    '</PTZData>';
  await client.text('PUT', `${ptzBase(recorder)}/${Number(channel)}/continuous`, { body });
}

/**
 * The paths of each detection setting, the most likely first. A recorder
 * relays the camera's settings through InputProxy; the Smart paths take the
 * recorder's channel id as is.
 */
export function detectionPaths(kind, recorder, channel) {
  const ch = Number(channel);
  switch (kind) {
    case 'motion': {
      const direct = `/ISAPI/System/Video/inputs/channels/${ch}/motionDetection`;
      const proxied = `/ISAPI/ContentMgmt/InputProxy/channels/${ch}/video/motionDetection`;
      return recorder ? [proxied, direct] : [direct];
    }
    case 'line_crossing':
      return [`/ISAPI/Smart/LineDetection/${ch}`];
    case 'intrusion':
      return [`/ISAPI/Smart/FieldDetection/${ch}`];
    case 'tamper': {
      const direct = `/ISAPI/System/Video/inputs/channels/${ch}/tamperDetection`;
      const proxied = `/ISAPI/ContentMgmt/InputProxy/channels/${ch}/video/tamperDetection`;
      return recorder ? [proxied, direct] : [direct];
    }
    default:
      return [];
  }
}

/** The detections the integration can read and switch. */
export const DETECTION_KINDS = ['motion', 'line_crossing', 'intrusion', 'tamper'];

/**
 * Read one detection setting.
 * @param {string[]} paths candidates, see detectionPaths
 * @returns {Promise<{ path: string, xml: string, enabled: boolean } | null>} null when unsupported
 */
export async function getDetection(client, paths) {
  for (const path of paths) {
    try {
      const xml = await client.text('GET', path);
      const enabled = readBoolean(xml, 'enabled');
      if (enabled !== undefined) {
        return { path, xml, enabled };
      }
    } catch (error) {
      rethrowConnectionError(error);
    }
  }
  return null;
}

/**
 * Switch a detection on or off: read the setting, change its first
 * `<enabled>` (the one of the whole setting), write it back. The rest of the
 * document (zones, sensitivity, schedule) goes back untouched.
 *
 * @returns {Promise<boolean>} the state written
 */
export async function setDetection(client, path, enabled) {
  const xml = await client.text('GET', path);
  const updated = replaceFirstTag(xml, 'enabled', enabled ? 'true' : 'false');
  if (updated === null) {
    throw new IsapiError('not_supported', `${client.label} ${path}: no <enabled> to switch`);
  }
  await client.text('PUT', path, { body: updated });
  return enabled;
}

/** Streaming id of a channel: 101 is channel 1's main stream, 102 its sub-stream. */
export function streamId(channel, stream) {
  return Number(channel) * 100 + (stream === 'main' ? 1 : 2);
}

function isJpeg(buffer) {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/**
 * Capture one JPEG of a channel, under the 150 KB Gladys accepts.
 *
 * The main stream of a 4 MP camera weighs 300 to 800 KB: it is asked for at
 * 1280×720 first (most firmwares honour the size), then the sub-stream takes
 * over. A sub-stream still over the limit is a camera set to a high sub-stream
 * resolution: the error says so.
 *
 * @param {'main' | 'sub'} stream preferred stream
 * @returns {Promise<Buffer>}
 */
export async function getSnapshot(client, channel, stream) {
  const attempts =
    stream === 'main'
      ? [
          `/ISAPI/Streaming/channels/${streamId(channel, 'main')}/picture?videoResolutionWidth=1280&videoResolutionHeight=720`,
          `/ISAPI/Streaming/channels/${streamId(channel, 'sub')}/picture`,
        ]
      : [`/ISAPI/Streaming/channels/${streamId(channel, 'sub')}/picture`];
  let lastSize = 0;
  for (const path of attempts) {
    const { body } = await client.bytes(path, { timeoutMs: 12_000 });
    if (!isJpeg(body)) {
      throw new IsapiError('http', `${client.label} ${path}: the answer is not a JPEG image`);
    }
    if (body.length <= MAX_IMAGE_BYTES) {
      return body;
    }
    lastSize = body.length;
  }
  throw new IsapiError(
    'too_large',
    `${client.label}: snapshot of channel ${channel} weighs ${Math.round(lastSize / 1024)} KB, ` +
      `over the 150 KB Gladys accepts: lower the sub-stream resolution of the camera`,
  );
}

/** Errors that say the device itself is out of reach must not be swallowed. */
function rethrowConnectionError(error) {
  if (
    !(error instanceof IsapiError) ||
    !['not_supported', 'forbidden', 'http'].includes(error.code)
  ) {
    throw error;
  }
}
