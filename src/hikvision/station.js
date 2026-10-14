// -----------------------------------------------------------------------------
// One Hikvision device (camera or recorder) at one address, as the
// integration knows it: what it is, which channels and contacts it has, which
// detections it lets us switch, whether it answers, and its alert stream.
//
// No Gladys here: the hub (src/hub.js) turns this into devices, states, scene
// events and badges. Everything the station learns comes from the device; the
// last discovery is kept in /data so a device that is off when the
// integration starts still has its Gladys devices known (and shown offline).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import { IsapiClient, IsapiError } from './client.js';
import { AlertStream } from './alertStream.js';
import {
  DETECTION_KINDS,
  continuousMove,
  detectionPaths,
  getChannels,
  getChannelsStatus,
  getDetection,
  getDeviceInfo,
  getIoPorts,
  getIoStatus,
  getPresets,
  getSnapshot,
  gotoPreset,
  ptzBase,
  setDetection,
  setOutput,
} from './isapi.js';

const logger = createLogger({ name: 'station' });

/** Codes that mean "the credentials are refused": never retried on a timer. */
export const AUTH_CODES = new Set(['auth', 'locked']);

// A PTZ step: how long a movement lasts before the camera stops by itself.
const PTZ_STEP_MS = 600;
const PTZ_SPEED = 60;

/** Gladys CAMERA/MOVE values -> PTZ speeds. 0 is stop. */
export const PTZ_MOVES = {
  1: { pan: -PTZ_SPEED },
  2: { pan: PTZ_SPEED },
  3: { tilt: PTZ_SPEED },
  4: { tilt: -PTZ_SPEED },
  5: { zoom: PTZ_SPEED },
  6: { zoom: -PTZ_SPEED },
};

export class Station extends EventEmitter {
  /**
   * @param {ReturnType<import('../config.js').parseHost>} host where the device answers
   * @param {object} config normalized configuration
   * @param {{ createClient?: Function, createStream?: Function, cached?: object }} [deps]
   */
  constructor(host, config, deps = {}) {
    super();
    this.host = host;
    this.label = host.label;
    this.config = config;
    const createClient = deps.createClient ?? ((options) => new IsapiClient(options));
    const createStream = deps.createStream ?? ((client) => new AlertStream(client));
    this.client = createClient({
      baseUrl: host.baseUrl,
      label: host.label,
      username: config.username,
      password: config.password,
      verifyTls: config.verify_tls,
    });
    this.createStream = createStream;
    this.stream = null;

    /** @type {Awaited<ReturnType<typeof getDeviceInfo>> | null} */
    this.info = null;
    this.recorder = false;
    /** @type {{ id: number, name: string, online: boolean, ptz: boolean,
     *   presets: { id: number, name: string }[], detections: Record<string, { path: string, enabled: boolean }> }[]} */
    this.channels = [];
    this.io = { inputs: [], outputs: [] };
    /** Live alarm I/O states: id -> active. */
    this.ioState = { inputs: new Map(), outputs: new Map() };
    /** true / false once known, null before the first answer. */
    this.reachable = null;
    this.lastError = null;
    this.authBlocked = false;
    this.streamConnected = false;
    /** The discovery comes from /data, not from the device (yet). */
    this.fromCache = false;
    this.ptzTimers = new Map();

    if (deps.cached?.info) {
      this.restore(deps.cached);
    }
  }

  /** The device answered at least once (now or in a previous run). */
  get known() {
    return this.info !== null;
  }

  /** What /data keeps of the last discovery. */
  snapshotState() {
    return {
      info: this.info,
      recorder: this.recorder,
      channels: this.channels.map(({ id, name, ptz, presets, detections }) => ({
        id,
        name,
        ptz,
        presets,
        detections: Object.fromEntries(
          Object.entries(detections).map(([kind, { path }]) => [kind, { path, enabled: false }]),
        ),
      })),
      io: this.io,
    };
  }

  restore(cached) {
    this.info = cached.info;
    this.recorder = Boolean(cached.recorder);
    this.channels = (cached.channels ?? []).map((channel) => ({
      ...channel,
      online: true,
      presets: channel.presets ?? [],
      detections: channel.detections ?? {},
    }));
    this.io = cached.io ?? { inputs: [], outputs: [] };
    this.fromCache = true;
  }

  /** Record a failure; true when it is the device being out of reach. */
  noteError(error) {
    this.lastError = error;
    if (AUTH_CODES.has(error?.code)) {
      // Every new attempt would be a failed login, and Hikvision locks the
      // account after a few: wait for a new configuration (or a manual test).
      this.authBlocked = true;
      this.stopStream();
    }
    this.reachable = false;
  }

  /**
   * Ask the device everything the Gladys devices are built from.
   * @returns {Promise<void>} rejects with an IsapiError when the device does not answer
   */
  async discover() {
    try {
      const info = await getDeviceInfo(this.client);
      const { recorder, channels } = await getChannels(this.client);
      const status = recorder ? await getChannelsStatus(this.client) : new Map();
      const probed = [];
      for (const channel of channels) {
        const online = status.get(channel.id) ?? true;
        probed.push(await this.probeChannel(recorder, { ...channel, online }));
      }
      const io = await getIoPorts(this.client);
      this.info = info;
      this.recorder = recorder;
      this.channels = probed;
      this.io = io;
      this.fromCache = false;
      this.reachable = true;
      this.lastError = null;
      this.authBlocked = false;
      logger.info(
        `${this.label}: ${info.model || info.deviceType} (${recorder ? 'recorder' : 'camera'}), ` +
          `${probed.length} channel(s), ${io.inputs.length} alarm input(s), ${io.outputs.length} alarm output(s)`,
      );
    } catch (error) {
      this.noteError(error);
      throw error;
    }
  }

  /**
   * What one channel supports. An offline camera behind a recorder answers
   * nothing: its detections are probed again when it comes back.
   */
  async probeChannel(recorder, channel) {
    const previous = this.channels.find((known) => known.id === channel.id);
    if (!channel.online && previous) {
      return { ...previous, name: channel.name || previous.name, online: false };
    }
    const detections = {};
    for (const kind of DETECTION_KINDS) {
      const found = await getDetection(this.client, detectionPaths(kind, recorder, channel.id));
      if (found) {
        detections[kind] = { path: found.path, enabled: found.enabled };
      }
    }
    let ptz = false;
    let presets = [];
    try {
      await this.client.text('GET', `${ptzBase(recorder)}/${channel.id}/capabilities`);
      ptz = true;
      presets = (await getPresets(this.client, recorder, channel.id)) ?? [];
    } catch (error) {
      if (
        !(error instanceof IsapiError) ||
        !['not_supported', 'forbidden', 'http'].includes(error.code)
      ) {
        throw error;
      }
    }
    return { id: channel.id, name: channel.name, online: channel.online, ptz, presets, detections };
  }

  /**
   * Health check: is the device there, which cameras answer behind it, the
   * alarm I/O and the detection switches.
   *
   * @returns {Promise<{ channelsBack: number[] }>} the channels that came back
   *   online, whose detections were never probed
   */
  async refresh() {
    try {
      await getDeviceInfo(this.client);
      this.reachable = true;
      this.lastError = null;
      const channelsBack = [];
      if (this.recorder) {
        const status = await getChannelsStatus(this.client);
        for (const channel of this.channels) {
          const online = status.get(channel.id) ?? channel.online;
          if (online && !channel.online) {
            channelsBack.push(channel.id);
          }
          channel.online = online;
        }
      }
      if (this.io.inputs.length > 0 || this.io.outputs.length > 0) {
        const { inputs, outputs } = await getIoStatus(this.client);
        for (const [id, active] of inputs) this.ioState.inputs.set(id, active);
        for (const [id, active] of outputs) this.ioState.outputs.set(id, active);
      }
      for (const channel of this.channels) {
        if (!channel.online) continue;
        for (const [kind, detection] of Object.entries(channel.detections)) {
          const found = await getDetection(this.client, [detection.path]);
          if (found) {
            detection.enabled = found.enabled;
          } else {
            logger.debug(`${this.label}: ${kind} of channel ${channel.id} no longer readable`);
          }
        }
      }
      return { channelsBack };
    } catch (error) {
      this.noteError(error);
      throw error;
    }
  }

  startStream() {
    if (this.stream || this.authBlocked) {
      return;
    }
    const stream = this.createStream(this.client);
    this.stream = stream;
    stream.on('alert', (alert) => this.emit('alert', alert));
    stream.on('connected', () => {
      this.streamConnected = true;
      this.emit('stream', true);
    });
    stream.on('disconnected', () => {
      this.streamConnected = false;
      this.emit('stream', false);
    });
    stream.on('auth-error', (error) => {
      this.noteError(error);
      this.emit('auth-error', error);
    });
    stream.start();
  }

  stopStream() {
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      stream.removeAllListeners();
      stream.stop();
    }
    if (this.streamConnected) {
      this.streamConnected = false;
      this.emit('stream', false);
    }
  }

  channel(id) {
    return this.channels.find((channel) => channel.id === Number(id));
  }

  /** One JPEG of a channel, ≤ 150 KB. */
  async snapshot(channelId) {
    try {
      return await getSnapshot(this.client, channelId, this.config.snapshot_stream);
    } catch (error) {
      if (['unreachable', 'timeout', 'auth', 'locked'].includes(error?.code)) {
        this.noteError(error);
      }
      throw error;
    }
  }

  async setOutput(id, on) {
    await setOutput(this.client, id, on);
    this.ioState.outputs.set(Number(id), on);
  }

  /**
   * Switch one detection of a channel.
   * @returns {Promise<boolean>} the state written
   */
  async setDetection(channelId, kind, enabled) {
    const detection = this.channel(channelId)?.detections[kind];
    if (!detection) {
      throw new IsapiError(
        'not_supported',
        `${this.label}: channel ${channelId} has no ${kind} detection`,
      );
    }
    await setDetection(this.client, detection.path, enabled);
    detection.enabled = enabled;
    return enabled;
  }

  async gotoPreset(channelId, presetId) {
    await gotoPreset(this.client, this.recorder, channelId, presetId);
  }

  /**
   * One PTZ step. The camera is asked for a momentary move it stops by itself;
   * a firmware that does not know it gets a continuous move and a stop sent
   * PTZ_STEP_MS later — that timer is the watchdog: a lost stop must never
   * leave a camera turning against its end stop.
   *
   * @param {number} move a CAMERA/MOVE value, 0 to stop
   */
  async move(channelId, move) {
    const id = Number(channelId);
    clearTimeout(this.ptzTimers.get(id));
    this.ptzTimers.delete(id);
    const speeds = PTZ_MOVES[move];
    if (!speeds) {
      await continuousMove(this.client, this.recorder, id, {});
      return;
    }
    const base = ptzBase(this.recorder);
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<PTZData version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">' +
      `<pan>${speeds.pan ?? 0}</pan><tilt>${speeds.tilt ?? 0}</tilt><zoom>${speeds.zoom ?? 0}</zoom>` +
      `<Momentary><duration>${PTZ_STEP_MS}</duration></Momentary></PTZData>`;
    try {
      await this.client.text('PUT', `${base}/${id}/momentary`, { body });
      return;
    } catch (error) {
      if (error?.code !== 'not_supported') {
        throw error;
      }
    }
    await continuousMove(this.client, this.recorder, id, speeds);
    const timer = setTimeout(() => {
      this.ptzTimers.delete(id);
      continuousMove(this.client, this.recorder, id, {}).catch((error) =>
        logger.error(`${this.label}: PTZ stop of channel ${id} failed`, error),
      );
    }, PTZ_STEP_MS);
    this.ptzTimers.set(id, timer);
  }

  /** Stop everything: stream, PTZ movements under way, sockets. */
  async close() {
    this.stopStream();
    this.removeAllListeners();
    // A movement waiting for its watchdog is stopped now, not abandoned.
    const moving = [...this.ptzTimers.keys()];
    for (const timer of this.ptzTimers.values()) {
      clearTimeout(timer);
    }
    this.ptzTimers.clear();
    await Promise.allSettled(
      moving.map((id) => continuousMove(this.client, this.recorder, id, {})),
    );
    this.client.close?.();
  }
}
