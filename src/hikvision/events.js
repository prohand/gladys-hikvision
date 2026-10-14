// -----------------------------------------------------------------------------
// The events a Hikvision device reports, and what Gladys makes of them.
//
// The device pushes `EventNotificationAlert` documents on its alert stream
// (see alertStream.js). Their `eventType` names are Hikvision's; the keys
// below are the integration's own, stored by the users in their scenes
// (scene trigger option values): they are never renamed.
// -----------------------------------------------------------------------------

import { readTag } from './xml.js';

/**
 * Hikvision eventType (lower case) -> event key of the integration.
 * Types absent from this table (disk full, IP conflict, illegal login…) are
 * device-health events: logged, never turned into detections.
 */
export const EVENT_TYPES = {
  vmd: 'motion',
  linedetection: 'line_crossing',
  fielddetection: 'intrusion',
  regionentrance: 'region_entrance',
  regionexiting: 'region_exiting',
  tamperdetection: 'tamper',
  shelteralarm: 'tamper',
  facedetection: 'face',
  scenechangedetection: 'scene_change',
  unattendedbaggage: 'unattended_object',
  attendedbaggage: 'object_removal',
  pir: 'pir',
  videoloss: 'video_loss',
  io: 'alarm_input',
};

/** Every event key, in the order the scene editor lists them. */
export const EVENT_KEYS = [
  'motion',
  'line_crossing',
  'intrusion',
  'region_entrance',
  'region_exiting',
  'tamper',
  'face',
  'scene_change',
  'unattended_object',
  'object_removal',
  'pir',
  'video_loss',
  'alarm_input',
];

/**
 * Event key -> binary feature of the camera device it lights up. The other
 * events only fire the scene trigger.
 */
export const EVENT_FEATURES = {
  motion: 'motion',
  pir: 'motion',
  line_crossing: 'line-crossing',
  intrusion: 'intrusion',
  tamper: 'tamper',
};

/**
 * What a smart event saw, as the two values scenes filter on.
 * @returns {'human' | 'vehicle' | ''}
 */
export function normalizeTarget(raw) {
  const text = String(raw ?? '').toLowerCase();
  if (/human|person|people|face/.test(text)) return 'human';
  if (/vehicle|car|truck|motor/.test(text)) return 'vehicle';
  return '';
}

/**
 * Read one `EventNotificationAlert` document.
 * @param {string} xml the document
 * @returns {{ type: string, key: string | undefined, active: boolean, channels: number[],
 *   inputPort: number | undefined, target: string, description: string, dateTime: string } | null}
 */
export function parseAlert(xml) {
  const type = readTag(xml, 'eventType')?.toLowerCase();
  if (!type) {
    return null;
  }
  // Recorders do not agree on which tag carries the camera: newer ones put
  // the channel in channelID, older and hybrid ones in dynChannelID (channelID
  // then counts the analog inputs first). Every candidate is kept, in order.
  const channels = ['channelID', 'dynChannelID', 'videoInputChannelID']
    .map((name) => Number(readTag(xml, name)))
    .filter((id, index, all) => Number.isInteger(id) && id > 0 && all.indexOf(id) === index);
  const portText = readTag(xml, 'inputIOPortID') ?? readTag(xml, 'dynInputIOPortID');
  const port = Number(portText);
  return {
    type,
    key: EVENT_TYPES[type],
    active: (readTag(xml, 'eventState') ?? 'active').toLowerCase() === 'active',
    channels,
    inputPort: Number.isInteger(port) && port > 0 ? port : undefined,
    target: normalizeTarget(readTag(xml, 'detectionTarget') ?? readTag(xml, 'targetType')),
    description: readTag(xml, 'eventDescription') ?? '',
    dateTime: readTag(xml, 'dateTime') ?? '',
  };
}

const START = '<EventNotificationAlert';
const END = '</EventNotificationAlert>';
const MAX_BUFFERED = 1024 * 1024;

/**
 * Cut the alert stream into documents.
 *
 * The stream is multipart/mixed, but the boundaries vary between firmwares
 * (some never send the closing one, some send JPEG parts in between). Looking
 * for the documents themselves works on all of them. Bytes are kept as latin1
 * (one char per byte, so binary parts cannot break the search) and decoded as
 * UTF-8 once a document is complete: camera names carry accents.
 */
export class AlertParser {
  constructor() {
    this.buffer = '';
  }

  /**
   * @param {Buffer} chunk bytes received
   * @returns {string[]} the complete documents found
   */
  push(chunk) {
    this.buffer += chunk.toString('latin1');
    const documents = [];
    for (;;) {
      const start = this.buffer.indexOf(START);
      if (start === -1) {
        // Keep just enough to find a start tag cut in two.
        this.buffer = this.buffer.slice(-START.length);
        break;
      }
      const end = this.buffer.indexOf(END, start);
      if (end === -1) {
        this.buffer = this.buffer.slice(start);
        if (this.buffer.length > MAX_BUFFERED) {
          // A document that never ends: drop it rather than grow forever.
          this.buffer = '';
        }
        break;
      }
      const latin1 = this.buffer.slice(start, end + END.length);
      documents.push(Buffer.from(latin1, 'latin1').toString('utf8'));
      this.buffer = this.buffer.slice(end + END.length);
    }
    return documents;
  }
}

/**
 * Turn the repeated alerts of a detection into one on/off transition.
 *
 * A camera repeats an `active` alert every second while it sees movement and
 * many firmwares never send the `inactive` one. A detection is therefore "on"
 * from the first alert to `holdMs` after the last one (or to an `inactive`
 * alert, when the camera sends it): one scene event per transition, never one
 * per alert.
 */
export class DetectionTracker {
  /**
   * @param {{ holdMs: number, onChange: (key: string, on: boolean, info: object) => void }} options
   */
  constructor({ holdMs, onChange }) {
    this.holdMs = holdMs;
    this.onChange = onChange;
    this.active = new Map();
  }

  /**
   * @param {string} key what is detected where (device + event key)
   * @param {boolean} on the alert says active (true) or inactive (false)
   * @param {object} info passed through to onChange
   */
  signal(key, on, info = {}) {
    const current = this.active.get(key);
    if (!on) {
      if (current) {
        clearTimeout(current.timer);
        this.active.delete(key);
        this.onChange(key, false, info);
      }
      return;
    }
    if (current) {
      clearTimeout(current.timer);
    }
    const timer = setTimeout(() => {
      this.active.delete(key);
      this.onChange(key, false, info);
    }, this.holdMs);
    timer.unref?.();
    this.active.set(key, { timer });
    if (!current) {
      this.onChange(key, true, info);
    }
  }

  /** Whether a detection is currently on. */
  isOn(key) {
    return this.active.has(key);
  }

  /** Forget every detection without reporting the ends (shutdown, reconfiguration). */
  clear() {
    for (const { timer } of this.active.values()) {
      clearTimeout(timer);
    }
    this.active.clear();
  }
}
