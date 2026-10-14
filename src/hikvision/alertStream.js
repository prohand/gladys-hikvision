// -----------------------------------------------------------------------------
// The alert stream of ONE device: GET /ISAPI/Event/notification/alertStream,
// a response that never ends, carrying an `EventNotificationAlert` document
// for every event (detections, alarm inputs, video loss…).
//
// It is the only way detections reach Gladys in real time without opening
// anything on the user's network: the integration calls the camera, never the
// other way round. Kept open for life:
//   - a device sends a heartbeat at least every ~10 s (a `videoloss` alert in
//     state inactive), so silence for IDLE_MS means a dead connection;
//   - lost, it is reopened with a growing delay (2 s to 60 s);
//   - refused for the password, it is NOT reopened: every attempt would be a
//     failed login, and Hikvision locks the account after a few. The station
//     decides when to try again (a new configuration, a successful login).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import { fromStatus } from './client.js';
import { AlertParser, parseAlert } from './events.js';

const logger = createLogger({ name: 'alert-stream' });

export const ALERT_STREAM_PATH = '/ISAPI/Event/notification/alertStream';
const IDLE_MS = 120_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * Events: `connected`, `disconnected` (error), `alert` (parsed alert),
 * `auth-error` (IsapiError, the stream stopped for good).
 */
export class AlertStream extends EventEmitter {
  /**
   * @param {import('./client.js').IsapiClient} client
   * @param {{ idleMs?: number, retryMinMs?: number, retryMaxMs?: number }} [options]
   */
  constructor(client, options = {}) {
    super();
    this.client = client;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.running = false;
    this.connected = false;
    this.retryDelay = this.retryMinMs;
    this.retryTimer = null;
    this.idleTimer = null;
    this.abort = null;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.open();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.idleTimer);
    this.abort?.();
    this.abort = null;
    this.setConnected(false);
  }

  setConnected(connected, error) {
    if (this.connected === connected) {
      return;
    }
    this.connected = connected;
    this.emit(connected ? 'connected' : 'disconnected', error);
  }

  async open() {
    if (!this.running) {
      return;
    }
    let response;
    try {
      // Only the wait for the headers is bounded: the body never ends.
      response = await this.client.request('GET', ALERT_STREAM_PATH, { stream: true });
    } catch (error) {
      this.fail(error);
      return;
    }
    if (!this.running) {
      response.abort?.();
      return;
    }
    if (!response.stream) {
      this.fail(fromStatus(response.status, response.body, `${this.client.label} alert stream`));
      return;
    }

    const parser = new AlertParser();
    this.abort = response.abort;
    this.retryDelay = this.retryMinMs;
    this.setConnected(true);
    this.touch();

    response.stream.on('data', (chunk) => {
      this.touch();
      for (const document of parser.push(chunk)) {
        const alert = parseAlert(document);
        if (alert) {
          this.emit('alert', alert);
        }
      }
    });
    const ended = (error) => {
      if (this.abort === response.abort) {
        this.abort = null;
        this.fail(error ?? new Error('alert stream closed by the device'));
      }
    };
    response.stream.on('end', () => ended());
    response.stream.on('error', (error) => ended(error));
    response.stream.on('close', () => ended());
  }

  /** Restart the silence watchdog. */
  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.warn(`${this.client.label}: no event for ${this.idleMs / 1000} s, reconnecting`);
      const abort = this.abort;
      this.abort = null;
      abort?.();
      this.fail(new Error('alert stream silent'));
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  fail(error) {
    clearTimeout(this.idleTimer);
    this.setConnected(false, error);
    if (!this.running) {
      return;
    }
    if (error?.code === 'auth' || error?.code === 'locked') {
      this.running = false;
      this.emit('auth-error', error);
      return;
    }
    if (error?.code === 'not_supported' || error?.code === 'forbidden') {
      logger.warn(`${this.client.label}: ${error.message} — detections will not reach Gladys`);
    } else {
      logger.debug(
        `${this.client.label}: alert stream lost (${error?.message}), retry in ${this.retryDelay / 1000} s`,
      );
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), this.retryDelay);
    this.retryTimer.unref?.();
    this.retryDelay = Math.min(this.retryMaxMs, this.retryDelay * 2);
  }
}
