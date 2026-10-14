// -----------------------------------------------------------------------------
// The hub: every configured Hikvision device (a Station) wired to Gladys.
//
// It owns the life of the stations (start, health checks, snapshots, the
// configuration changing under them) and turns what they learn into Gladys
// terms: discovered devices, states, camera images, scene events, transport
// badges, the connection status. The SDK handlers in index.js, the scene
// actions and the widget all go through it.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { localize, pick } from './i18n.js';
import { DetectionTracker, EVENT_FEATURES } from './hikvision/events.js';
import { Station } from './hikvision/station.js';
import { DETECTION_KINDS } from './hikvision/isapi.js';
import {
  buildCameraDevice,
  cameraStates,
  deviceExternalId as cameraExternalId,
  setCameraValue,
} from './devices/camera.js';
import {
  alarmIoStates,
  buildAlarmIoDevice,
  deviceExternalId as alarmIoExternalId,
  hasAlarmIo,
  inputKey,
  setAlarmIoValue,
} from './devices/alarmIO.js';
import { explainError } from './messages.js';
import { loadStations, saveStations, DATA_DIR } from './store.js';
import { createHash } from 'node:crypto';

const logger = createLogger({ name: 'hub' });

/** Scene trigger keys fired by the hub: declared in the manifest, never renamed. */
export const TRIGGERS = {
  EVENT_DETECTED: 'event_detected',
  CAMERA_OFFLINE: 'camera_offline',
  CAMERA_ONLINE: 'camera_online',
};

/** Widget key, as declared in the manifest `widgets` field. */
export const WIDGET_KEY = 'hikvision';

// A stable value is re-sent every 30 minutes, so Gladys keeps it recently dated.
const HEARTBEAT_MS = 30 * 60 * 1000;
// The core takes one widget nudge per 10 s; later ones would be dropped.
const WIDGET_NUDGE_MS = 10_000;
// A snapshot this recent answers a "fresh image" request as well as a new one.
const FRESH_IMAGE_MS = 2_000;
// The detections counted by the widget.
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_EVENTS = 1000;

/** The JPEG as Gladys takes a camera image. */
export function toImageUri(jpeg) {
  return `image/jpg;base64,${jpeg.toString('base64')}`;
}

export class Hub {
  /**
   * @param {object} gladys SDK client (GladysIntegration or the SDK fake)
   * @param {{ createClient?: Function, createStream?: Function, dataDir?: string,
   *   now?: () => number }} [deps] test seams
   */
  constructor(gladys, deps = {}) {
    this.gladys = gladys;
    this.deps = deps;
    this.dataDir = deps.dataDir ?? DATA_DIR;
    this.now = deps.now ?? (() => Date.now());
    this.config = normalizeConfig();
    /** @type {Station[]} */
    this.stations = [];
    /** Gladys device external_id -> { station, kind: 'camera' | 'io', channel? } */
    this.registry = new Map();
    /** Feature external ids of the published devices. */
    this.features = new Set();
    /** Camera device external_id -> { buffer, at, key } (last snapshot). */
    this.images = new Map();
    /** Camera device external_id -> { key, target, at } (last detection). */
    this.lastEvents = new Map();
    this.recentEvents = [];
    /** Camera device external_id -> online, as last reported by a scene event. */
    this.online = new Map();
    this.timers = [];
    this.snapshotRunning = false;
    this.refreshing = new Set();
    this.generation = 0;
    this.widgetNudge = { last: 0, timer: null };
    this.tracker = this.createTracker();
  }

  createTracker() {
    return new DetectionTracker({
      holdMs: this.config.event_hold * 1000,
      onChange: (_key, on, info) => {
        this.onDetection(on, info).catch((error) =>
          logger.error('Publishing a detection failed', error),
        );
      },
    });
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start everything for a configuration: called on connection and on
   * every configuration saved.
   * @param {ReturnType<typeof normalizeConfig>} config
   */
  async start(config) {
    await this.stop();
    const generation = ++this.generation;
    this.config = config;
    this.tracker = this.createTracker();

    const cache = await loadStations(this.dataDir);
    this.stations = config.stations.map((host) => this.createStation(host, cache[host.baseUrl]));
    await Promise.all(this.stations.map((station) => this.discoverStation(station)));
    if (generation !== this.generation) {
      return;
    }
    await this.persist();
    this.rebuildRegistry();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports();
    for (const station of this.stations) {
      if (station.reachable) {
        station.startStream();
      }
      this.noteConnectivity(station, { fireEvents: false });
    }
    this.schedule();
    await this.reportStatus();
    this.nudgeWidget();
  }

  /** Stop the timers, the streams and the sockets. */
  async stop() {
    this.generation += 1;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    clearTimeout(this.widgetNudge.timer);
    this.tracker.clear();
    const stations = this.stations;
    this.stations = [];
    this.registry.clear();
    await Promise.allSettled(stations.map((station) => station.close()));
  }

  createStation(host, cached) {
    const station = new Station(host, this.config, {
      createClient: this.deps.createClient,
      createStream: this.deps.createStream,
      cached,
    });
    station.on('alert', (alert) => this.handleAlert(station, alert));
    station.on('stream', () => this.onStationChanged(station));
    station.on('auth-error', (error) => {
      logger.error(
        `${station.label}: ${error.message}; not retried until the configuration is saved`,
      );
      this.onStationChanged(station);
    });
    return station;
  }

  async discoverStation(station) {
    try {
      await station.discover();
      return true;
    } catch (error) {
      logger.warn(`${station.label}: ${error.message}`);
      return false;
    }
  }

  schedule() {
    for (const station of this.stations) {
      const timer = setInterval(
        () => this.refreshStation(station).catch((error) => logger.error('Refresh failed', error)),
        this.config.refresh_interval * 1000,
      );
      timer.unref?.();
      this.timers.push(timer);
    }
    if (this.config.snapshot_interval > 0) {
      const timer = setInterval(
        () => this.snapshotTick().catch((error) => logger.error('Snapshot loop failed', error)),
        this.config.snapshot_interval * 1000,
      );
      timer.unref?.();
      this.timers.push(timer);
    }
  }

  /**
   * One health check of a station. A station never discovered (or only known
   * from /data) is discovered; one whose camera came back online is
   * re-discovered, its detections were never probed.
   */
  async refreshStation(station) {
    if (station.authBlocked || this.refreshing.has(station)) {
      return;
    }
    this.refreshing.add(station);
    const generation = this.generation;
    try {
      let devicesChanged = false;
      if (!station.known || station.fromCache) {
        devicesChanged = await this.discoverStation(station);
      } else {
        try {
          const { channelsBack } = await station.refresh();
          if (channelsBack.length > 0) {
            devicesChanged = await this.discoverStation(station);
          }
        } catch (error) {
          logger.debug(`${station.label}: health check failed: ${error.message}`);
        }
      }
      if (generation !== this.generation) {
        return;
      }
      if (devicesChanged) {
        await this.persist();
        this.rebuildRegistry();
        await this.publishDevices();
      }
      if (station.reachable) {
        station.startStream();
      }
      await this.publishStates([station]);
      await this.publishTransports([station]);
      this.noteConnectivity(station, { fireEvents: true });
      await this.reportStatus();
      this.nudgeWidget();
    } finally {
      this.refreshing.delete(station);
    }
  }

  /** The event stream connected or dropped, or the password was refused. */
  onStationChanged(station) {
    this.publishTransports([station])
      .then(() => this.reportStatus())
      .catch((error) => logger.error('Status update failed', error));
    this.nudgeWidget();
  }

  /** Keep the last discovery of the configured stations in /data. */
  async persist() {
    const previous = await loadStations(this.dataDir);
    const state = {};
    for (const station of this.stations) {
      if (station.known && !station.fromCache) {
        state[station.host.baseUrl] = station.snapshotState();
      } else if (previous[station.host.baseUrl]) {
        state[station.host.baseUrl] = previous[station.host.baseUrl];
      }
    }
    await saveStations(state, this.dataDir);
  }

  // --- Devices -----------------------------------------------------------------

  rebuildRegistry() {
    this.registry.clear();
    for (const station of this.stations) {
      if (!station.known) continue;
      for (const channel of station.channels) {
        this.registry.set(cameraExternalId(this.gladys, station, channel), {
          station,
          kind: 'camera',
          channel,
        });
      }
      if (hasAlarmIo(station)) {
        this.registry.set(alarmIoExternalId(this.gladys, station), { station, kind: 'io' });
      }
    }
  }

  /** The discovery payload: every device of every station known. */
  discoveredDevices() {
    const devices = [];
    for (const station of this.stations) {
      if (!station.known) continue;
      for (const channel of station.channels) {
        devices.push(buildCameraDevice(this.gladys, station, channel));
      }
      if (hasAlarmIo(station)) {
        devices.push(buildAlarmIoDevice(this.gladys, station));
      }
    }
    return devices;
  }

  async publishDevices() {
    const devices = this.discoveredDevices();
    this.features = new Set(devices.flatMap((device) => device.features.map((f) => f.external_id)));
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (error) {
      logger.error('Gladys refused the device list', error);
      throw error;
    }
  }

  /** Detection switches and alarm contacts, deduplicated. */
  async publishStates(stations = this.stations) {
    const states = [];
    for (const station of stations) {
      if (!station.known || !station.reachable) continue;
      for (const channel of station.channels) {
        if (channel.online) {
          states.push(...cameraStates(this.gladys, station, channel));
        }
      }
      if (hasAlarmIo(station)) {
        states.push(...alarmIoStates(this.gladys, station));
      }
    }
    const known = states.filter((state) => this.features.has(state.device_feature_external_id));
    if (known.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(known, { heartbeat: HEARTBEAT_MS });
    } catch (error) {
      logger.warn(`Publishing states failed: ${error.message}`);
    }
  }

  /** Everything again, e.g. after the user created a device. */
  async republishStates() {
    this.gladys.forgetPublishedStates?.();
    await this.publishStates();
  }

  /** Whether the user created this device in Gladys. */
  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  // --- Transport badges, online / offline ------------------------------------

  /** Is a camera channel online right now? */
  channelOnline(station, channel) {
    return station.reachable === true && channel.online !== false;
  }

  transportEntry(station, online) {
    if (!online) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (!station.streamConnected) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: {
          en: 'Event stream not connected: detections do not reach Gladys',
          fr: "Flux d'événements non connecté : les détections n'arrivent pas dans Gladys",
          de: 'Ereignisstream nicht verbunden: Erkennungen erreichen Gladys nicht',
          es: 'Flujo de eventos no conectado: las detecciones no llegan a Gladys',
        },
      };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishTransports(stations = this.stations) {
    const entries = [];
    for (const [externalId, entry] of this.registry) {
      if (!stations.includes(entry.station)) continue;
      const online =
        entry.kind === 'camera'
          ? this.channelOnline(entry.station, entry.channel)
          : entry.station.reachable === true;
      entries.push({ external_id: externalId, ...this.transportEntry(entry.station, online) });
    }
    // The host API takes 100 entries per request.
    for (let index = 0; index < entries.length; index += 100) {
      try {
        await this.gladys.publishTransports(entries.slice(index, index + 100));
      } catch (error) {
        logger.warn(`Publishing transport badges failed: ${error.message}`);
      }
    }
  }

  /**
   * Fire camera_offline / camera_online on the transitions of each camera. The
   * first state seen after a start is a baseline, never an event.
   */
  noteConnectivity(station, { fireEvents }) {
    if (!station.known || station.reachable === null) {
      return;
    }
    for (const channel of station.channels) {
      const externalId = cameraExternalId(this.gladys, station, channel);
      const online = this.channelOnline(station, channel);
      const before = this.online.get(externalId);
      this.online.set(externalId, online);
      if (!fireEvents || before === undefined || before === online) {
        continue;
      }
      const reason = station.reachable
        ? 'channel_offline'
        : (station.lastError?.code ?? 'unreachable');
      logger.info(
        `${station.label}: channel ${channel.id} ${online ? 'back online' : `offline (${reason})`}`,
      );
      const data = {
        device: externalId,
        device_name: buildCameraDevice(this.gladys, station, channel).name,
      };
      if (online) {
        this.fireSceneEvent(TRIGGERS.CAMERA_ONLINE, data);
      } else {
        this.fireSceneEvent(TRIGGERS.CAMERA_OFFLINE, { ...data, reason });
      }
    }
  }

  // --- Events ------------------------------------------------------------------

  fireSceneEvent(key, data) {
    this.gladys
      .publishSceneEvent(key, data)
      .catch((error) => logger.warn(`Scene event ${key} refused: ${error.message}`));
  }

  /** Find the channel an alert talks about (see parseAlert for the candidates). */
  alertChannel(station, alert) {
    for (const id of alert.channels) {
      const channel = station.channel(id);
      if (channel) return channel;
    }
    // Hybrid recorders number the IP cameras after their 32 analog inputs.
    for (const id of alert.channels) {
      const channel = id > 32 ? station.channel(id - 32) : undefined;
      if (channel) return channel;
    }
    return alert.channels.length === 0 && station.channels.length === 1
      ? station.channels[0]
      : undefined;
  }

  handleAlert(station, alert) {
    if (!alert.key) {
      logger.debug(
        `${station.label}: ${alert.type} (${alert.active ? 'active' : 'inactive'}) ignored`,
      );
      return;
    }
    // The heartbeat of the stream is a video loss alert in state inactive.
    if (alert.key === 'video_loss' && !alert.active) {
      return;
    }
    logger.debug(
      `${station.label}: ${alert.type} ${alert.active ? 'active' : 'inactive'} ` +
        `channel ${alert.channels.join('/') || '-'} port ${alert.inputPort ?? '-'} ${alert.target}`,
    );
    if (alert.key === 'alarm_input' && alert.inputPort !== undefined && hasAlarmIo(station)) {
      this.handleInput(station, alert);
      return;
    }
    if (!station.known) {
      return;
    }
    const channel = this.alertChannel(station, alert);
    if (!channel) {
      logger.debug(
        `${station.label}: ${alert.type} on an unknown channel ${alert.channels.join('/')}`,
      );
      return;
    }
    const device = cameraExternalId(this.gladys, station, channel);
    this.tracker.signal(`${device}|${alert.key}`, alert.active, {
      station,
      channel,
      device,
      key: alert.key,
      target: alert.target,
      description: alert.description,
    });
  }

  /** An alarm input changed: a state, and a scene event when it goes active. */
  handleInput(station, alert) {
    const port = alert.inputPort;
    const known = station.io.inputs.some((input) => input.id === port);
    const before = station.ioState.inputs.get(port);
    station.ioState.inputs.set(port, alert.active);
    if (before === alert.active) {
      return;
    }
    const device = alarmIoExternalId(this.gladys, station);
    const feature = this.gladys
      .externalIds('alarm-io', station.info.serialNumber)
      .feature(inputKey(port));
    if (known && this.features.has(feature)) {
      this.gladys
        .publishState(feature, alert.active ? 1 : 0)
        .catch((error) => logger.warn(`Alarm input state refused: ${error.message}`));
    }
    if (alert.active) {
      this.fireSceneEvent(TRIGGERS.EVENT_DETECTED, {
        device,
        event_type: 'alarm_input',
        target: '',
        device_name: buildAlarmIoDevice(this.gladys, station).name,
        channel: port,
        description: alert.description,
      });
      this.recordEvent(device, 'alarm_input', '');
    }
    this.nudgeWidget();
  }

  recordEvent(device, key, target) {
    const at = this.now();
    this.lastEvents.set(device, { key, target, at });
    this.recentEvents.push(at);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.splice(0, this.recentEvents.length - MAX_RECENT_EVENTS);
    }
  }

  /** A detection started (on) or ended (off): see DetectionTracker. */
  async onDetection(on, { station, channel, device, key, target, description }) {
    const featureKey = EVENT_FEATURES[key];
    if (featureKey) {
      const feature = `${device}:${featureKey}`;
      if (this.features.has(feature)) {
        await this.gladys.publishState(feature, on ? 1 : 0);
      }
    }
    if (on) {
      this.recordEvent(device, key, target);
      // One event per transition, never one per alert (300 events a minute).
      this.fireSceneEvent(TRIGGERS.EVENT_DETECTED, {
        device,
        event_type: key,
        target,
        device_name: buildCameraDevice(this.gladys, station, channel).name,
        channel: channel.id,
        description,
      });
    }
    this.nudgeWidget();
  }

  /** "Re-pull the widget", at most once per 10 s, the last change never lost. */
  nudgeWidget() {
    const now = this.now();
    const wait = this.widgetNudge.last + WIDGET_NUDGE_MS - now;
    if (wait <= 0) {
      this.widgetNudge.last = now;
      this.gladys.requestWidgetRefresh?.(WIDGET_KEY);
      return;
    }
    if (!this.widgetNudge.timer) {
      this.widgetNudge.timer = setTimeout(() => {
        this.widgetNudge.timer = null;
        this.nudgeWidget();
      }, wait);
      this.widgetNudge.timer.unref?.();
    }
  }

  // --- Images ------------------------------------------------------------------

  storeImage(externalId, buffer) {
    const key = `cam-${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}`;
    const image = { buffer, at: this.now(), key };
    this.images.set(externalId, image);
    return image;
  }

  /** The widget asks for an image by its key. */
  imageByKey(key) {
    for (const image of this.images.values()) {
      if (image.key === key) return image;
    }
    return undefined;
  }

  cameraEntry(externalId) {
    const entry = this.registry.get(externalId);
    if (!entry || entry.kind !== 'camera') {
      throw new Error(`${externalId} is not a Hikvision camera known to the integration`);
    }
    return entry;
  }

  /**
   * A snapshot of one camera, a recent one when it is fresh enough.
   * @returns {Promise<{ buffer: Buffer, at: number, key: string }>}
   */
  async captureImage(externalId, maxAgeMs = FRESH_IMAGE_MS) {
    const cached = this.images.get(externalId);
    if (cached && this.now() - cached.at <= maxAgeMs) {
      return cached;
    }
    const { station, channel } = this.cameraEntry(externalId);
    const jpeg = await station.snapshot(channel.id);
    return this.storeImage(externalId, jpeg);
  }

  /** onGetImage: a fresh image, as Gladys takes it. */
  async getImage(externalId) {
    const image = await this.captureImage(externalId);
    return toImageUri(image.buffer);
  }

  /** Capture and push a camera's image now (scene action, widget button). */
  async snapshotNow(externalId) {
    const image = await this.captureImage(externalId, 0);
    await this.gladys.publishCameraImage(externalId, toImageUri(image.buffer));
    this.nudgeWidget();
    return image;
  }

  /** The periodic snapshots of every online camera the user created. */
  async snapshotTick() {
    if (this.snapshotRunning) {
      return;
    }
    this.snapshotRunning = true;
    try {
      await Promise.all(
        this.stations.map(async (station) => {
          for (const channel of station.channels) {
            if (!this.channelOnline(station, channel)) continue;
            const externalId = cameraExternalId(this.gladys, station, channel);
            if (!this.isCreated(externalId)) continue;
            try {
              const jpeg = await station.snapshot(channel.id);
              this.storeImage(externalId, jpeg);
              await this.gladys.publishCameraImage(externalId, toImageUri(jpeg));
            } catch (error) {
              logger.warn(
                `${station.label}: snapshot of channel ${channel.id} failed: ${error.message}`,
              );
              if (!station.reachable) break;
            }
          }
        }),
      );
    } finally {
      this.snapshotRunning = false;
    }
  }

  // --- Commands ----------------------------------------------------------------

  /** onSetValue: a command from Gladys. */
  async setValue(device, feature, value) {
    const entry = this.registry.get(device.external_id);
    if (!entry) {
      throw new Error(`${device.external_id} is not known: is its camera or recorder configured?`);
    }
    const featureKey = feature.external_id.slice(device.external_id.length + 1);
    const command = {
      station: entry.station,
      channel: entry.channel,
      featureKey,
      featureExternalId: feature.external_id,
      value,
    };
    if (entry.kind === 'camera') {
      await setCameraValue(this.gladys, command);
    } else {
      await setAlarmIoValue(this.gladys, command);
    }
  }

  /**
   * Switch one detection of one camera.
   * @returns {Promise<boolean>} the state written
   */
  async setDetection(externalId, kind, enabled) {
    const { station, channel } = this.cameraEntry(externalId);
    const written = await station.setDetection(channel.id, kind, enabled);
    const toggle = `${externalId}:${kind.replace(/_/g, '-')}-enabled`;
    if (this.features.has(toggle)) {
      await this.gladys.publishState(toggle, written ? 1 : 0);
    }
    return written;
  }

  /**
   * Switch every detection of every camera (the widget's arm / disarm).
   * @returns {Promise<{ changed: number, failed: number }>}
   */
  async setAllDetections(enabled) {
    let changed = 0;
    let failed = 0;
    for (const [externalId, entry] of this.registry) {
      if (entry.kind !== 'camera' || !this.channelOnline(entry.station, entry.channel)) continue;
      for (const kind of DETECTION_KINDS) {
        if (!entry.channel.detections[kind]) continue;
        try {
          await this.setDetection(externalId, kind, enabled);
          changed += 1;
        } catch (error) {
          failed += 1;
          logger.warn(
            `${entry.station.label}: ${kind} of channel ${entry.channel.id}: ${error.message}`,
          );
        }
      }
    }
    return { changed, failed };
  }

  async gotoPreset(externalId, presetId) {
    const { station, channel } = this.cameraEntry(externalId);
    if (!channel.ptz) {
      throw new Error(`${externalId} has no PTZ`);
    }
    await station.gotoPreset(channel.id, presetId);
  }

  // --- Status ------------------------------------------------------------------

  /** The Configuration screen status: connected when every device answers. */
  async reportStatus() {
    const { stations, invalidHosts } = this.config;
    let status;
    if (stations.length === 0) {
      status = [
        false,
        invalidHosts.length > 0
          ? {
              en: `Not an address: ${invalidHosts.join(', ')}`,
              fr: `Adresse non valide : ${invalidHosts.join(', ')}`,
              de: `Keine gültige Adresse: ${invalidHosts.join(', ')}`,
              es: `Dirección no válida: ${invalidHosts.join(', ')}`,
            }
          : {
              en: 'Enter the address of a camera or recorder',
              fr: "Saisissez l'adresse d'une caméra ou d'un enregistreur",
              de: 'Gib die Adresse einer Kamera oder eines Rekorders ein',
              es: 'Introduzca la dirección de una cámara o un grabador',
            },
      ];
    } else {
      const failing = this.stations.filter((station) => station.reachable !== true);
      if (failing.length === 0) {
        status = [true];
      } else {
        status = [
          false,
          localize((language) =>
            failing
              .map(
                (station) => `${station.label}: ${pick(language, explainError(station.lastError))}`,
              )
              .join(' — ')
              .slice(0, 500),
          ),
        ];
      }
    }
    try {
      await this.gladys.setConnectionStatus(...status);
    } catch (error) {
      logger.warn(`Connection status refused: ${error.message}`);
    }
  }

  /**
   * Retry one station now, password refusals included: the user asked for it
   * (Test the connection). Publishes what it finds.
   */
  async retest(station) {
    station.authBlocked = false;
    const ok = await this.discoverStation(station);
    if (ok) {
      await this.persist();
      this.rebuildRegistry();
      await this.publishDevices();
      station.startStream();
      await this.publishStates([station]);
    }
    await this.publishTransports([station]);
    this.noteConnectivity(station, { fireEvents: true });
    await this.reportStatus();
    this.nudgeWidget();
    return ok;
  }

  /** What the widget and the connection test show. */
  cameras() {
    const cameras = [];
    for (const [externalId, entry] of this.registry) {
      if (entry.kind !== 'camera') continue;
      cameras.push({
        externalId,
        station: entry.station,
        channel: entry.channel,
        name: buildCameraDevice(this.gladys, entry.station, entry.channel).name,
        online: this.channelOnline(entry.station, entry.channel),
        lastEvent: this.lastEvents.get(externalId),
      });
    }
    return cameras;
  }

  /** Detections over the last 24 hours. */
  recentEventCount() {
    const since = this.now() - RECENT_WINDOW_MS;
    this.recentEvents = this.recentEvents.filter((at) => at >= since);
    return this.recentEvents.length;
  }
}
