// -----------------------------------------------------------------------------
// HTTP client of ONE Hikvision device (camera or recorder), over its local
// ISAPI.
//
// Built on node:http / node:https rather than fetch for two reasons: the
// cameras serve HTTPS with a self-signed certificate (fetch has no per-request
// way to accept it without a dependency), and the event stream is a response
// that never ends, read as it comes.
//
// Every failure becomes an `IsapiError` with a `code` the rest of the
// integration can act on and explain: `unreachable`, `timeout`, `tls`, `auth`,
// `locked`, `forbidden`, `not_supported`, `too_large`, `http`.
//
// One rule matters more than the others: a wrong password must cost ONE failed
// login per request, never more. Hikvision locks the account (or the client
// address) for up to 30 minutes after a handful of failures, and a lock looks
// exactly like a wrong password from the outside.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { buildAuthorization, parseChallenge } from './digest.js';
import { readTag } from './xml.js';

export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

export class IsapiError extends Error {
  /**
   * @param {string} code machine-readable reason (see the file header)
   * @param {string} message English detail, for the logs
   * @param {{ status?: number, retryLoginTime?: number }} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IsapiError';
    this.code = code;
    this.status = details.status;
    this.retryLoginTime = details.retryLoginTime;
  }
}

/**
 * The `ResponseStatus` / `userCheck` document Hikvision returns with an error.
 * @param {Buffer | string} body response body
 */
export function parseResponseStatus(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  const retry = Number(readTag(text, 'retryLoginTime'));
  return {
    statusCode: readTag(text, 'statusCode'),
    statusString: readTag(text, 'statusString'),
    subStatusCode: readTag(text, 'subStatusCode'),
    locked: readTag(text, 'lockStatus')?.toLowerCase() === 'lock',
    retryLoginTime: Number.isFinite(retry) ? retry : undefined,
  };
}

/** A node error (socket, TLS) as an IsapiError. */
function fromSocketError(error, label) {
  if (error instanceof IsapiError) {
    return error;
  }
  const code = error?.code ?? '';
  if (UNREACHABLE_CODES.has(code)) {
    return new IsapiError('unreachable', `${label}: ${code}`);
  }
  if (
    /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/i.test(code) ||
    /certificate/i.test(error?.message)
  ) {
    return new IsapiError('tls', `${label}: certificate refused (${code || error.message})`);
  }
  if (/EPROTO|wrong version number/i.test(`${code} ${error?.message}`)) {
    return new IsapiError('tls', `${label}: HTTPS answered on an HTTP port, or the reverse`);
  }
  return new IsapiError(
    'unreachable',
    `${label}: ${code || error?.message || 'connection failed'}`,
  );
}

/** An HTTP status other than 2xx / 401 as an IsapiError. */
export function fromStatus(status, body, label) {
  const detail = parseResponseStatus(body);
  const text = detail.statusString
    ? ` (${detail.statusString}${detail.subStatusCode ? `, ${detail.subStatusCode}` : ''})`
    : '';
  if (status === 404 || (status === 403 && /notSupport/i.test(detail.subStatusCode ?? ''))) {
    return new IsapiError('not_supported', `${label}: not supported${text}`, { status });
  }
  if (status === 403) {
    return new IsapiError('forbidden', `${label}: forbidden${text}`, { status });
  }
  return new IsapiError('http', `${label}: HTTP ${status}${text}`, { status });
}

export class IsapiClient {
  /**
   * @param {{ baseUrl: string, label?: string, username: string, password: string,
   *   verifyTls?: boolean, timeoutMs?: number }} options
   */
  constructor({
    baseUrl,
    label,
    username,
    password,
    verifyTls = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    this.baseUrl = baseUrl;
    this.label = label ?? baseUrl;
    this.username = username;
    this.password = password;
    this.verifyTls = verifyTls;
    this.timeoutMs = timeoutMs;
    this.challenge = null;
    this.nonceCount = 0;
    const isHttps = baseUrl.startsWith('https:');
    // A few sockets, kept alive: the devices serve few concurrent clients, and
    // the snapshot loop of a recorder makes many requests in a row.
    this.agent = new (isHttps ? https : http).Agent({
      keepAlive: true,
      maxSockets: 4,
      rejectUnauthorized: verifyTls,
    });
  }

  /** Close the idle sockets (on a configuration change or a shutdown). */
  close() {
    this.agent.destroy();
  }

  /**
   * One HTTP exchange, without authentication logic.
   * @returns {Promise<{ status: number, headers: object, rawHeaders: string[], body?: Buffer,
   *   stream?: import('node:http').IncomingMessage, abort?: () => void }>}
   */
  send(url, { method, headers, body, timeoutMs, stream, maxBytes }) {
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn(value);
        }
      };
      const request = lib.request(
        url,
        {
          method,
          headers,
          // The event stream gets a connection of its own: it never gives it back.
          agent: stream ? false : this.agent,
          rejectUnauthorized: this.verifyTls,
        },
        (response) => {
          const base = {
            status: response.statusCode,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
          };
          if (stream && response.statusCode === 200) {
            finish(resolve, { ...base, stream: response, abort: () => request.destroy() });
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              request.destroy(
                new IsapiError('too_large', `${this.label}: answer over ${maxBytes} bytes`),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => finish(resolve, { ...base, body: Buffer.concat(chunks) }));
          response.on('error', (error) => finish(reject, fromSocketError(error, this.label)));
        },
      );
      const timer = setTimeout(() => {
        request.destroy(
          new IsapiError('timeout', `${this.label}: no answer within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      request.on('error', (error) => finish(reject, fromSocketError(error, this.label)));
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }

  /**
   * An authenticated request. Resolves whatever the status (but 401), so the
   * caller decides what a 404 means; rejects with an IsapiError otherwise.
   *
   * @param {string} method HTTP method
   * @param {string} path ISAPI path, query string included
   * @param {{ body?: string | Buffer, contentType?: string, timeoutMs?: number,
   *   stream?: boolean, maxBytes?: number }} [options]
   */
  async request(method, path, options = {}) {
    const url = new URL(path, this.baseUrl);
    const uri = `${url.pathname}${url.search}`;
    const { body, contentType, stream = false } = options;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

    let challenge = this.challenge;
    let fromCache = challenge !== null;
    for (;;) {
      const headers = { Accept: '*/*' };
      if (body !== undefined) {
        headers['Content-Type'] = contentType ?? 'application/xml; charset="UTF-8"';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      if (challenge) {
        this.nonceCount += 1;
        headers.Authorization = buildAuthorization(challenge, {
          username: this.username,
          password: this.password,
          method,
          uri,
          nc: this.nonceCount,
        });
      }
      const response = await this.send(url, { method, headers, body, timeoutMs, stream, maxBytes });
      if (response.status !== 401) {
        this.challenge = challenge;
        return response;
      }

      const offered = parseChallenge(wwwAuthenticate(response.rawHeaders));
      const status = parseResponseStatus(response.body);
      // Retry once without counting a failure: no credentials were sent yet,
      // the cached nonce expired, or the device itself says it is stale.
      const retry = offered && (!challenge || fromCache || offered.stale) && !status.locked;
      if (!retry) {
        this.challenge = null;
        if (status.locked) {
          throw new IsapiError('locked', `${this.label}: account locked after failed logins`, {
            status: 401,
            retryLoginTime: status.retryLoginTime,
          });
        }
        throw new IsapiError('auth', `${this.label}: user name or password refused`, {
          status: 401,
          retryLoginTime: status.retryLoginTime,
        });
      }
      challenge = offered;
      fromCache = false;
      this.nonceCount = 0;
    }
  }

  /**
   * GET (or another method) that must answer 2xx: the body as text.
   * @returns {Promise<string>}
   */
  async text(method, path, options) {
    const response = await this.request(method, path, options);
    if (response.status < 200 || response.status >= 300) {
      throw fromStatus(response.status, response.body, `${this.label} ${method} ${path}`);
    }
    return response.body.toString('utf8');
  }

  /** GET that must answer 2xx: the body as bytes, with its content type. */
  async bytes(path, options) {
    const response = await this.request('GET', path, options);
    if (response.status < 200 || response.status >= 300) {
      throw fromStatus(response.status, response.body, `${this.label} GET ${path}`);
    }
    return { body: response.body, contentType: String(response.headers['content-type'] ?? '') };
  }
}

/** Every WWW-Authenticate header, as received (Node joins duplicates). */
function wwwAuthenticate(rawHeaders = []) {
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === 'www-authenticate') {
      values.push(rawHeaders[index + 1]);
    }
  }
  return values;
}
