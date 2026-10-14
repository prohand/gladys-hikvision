// -----------------------------------------------------------------------------
// HTTP Digest authentication (RFC 7616), the scheme every Hikvision device
// asks for on its ISAPI. Basic is only offered when the installer enabled it;
// it is supported too, never preferred.
//
// The challenge is kept and reused (the nonce count goes up at each request),
// so a device answers in one round trip instead of two: that halves the
// requests of a snapshot loop over a 16-channel recorder.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

const HASHES = { md5: 'md5', 'sha-256': 'sha256' };

/**
 * Parse the WWW-Authenticate headers of a 401.
 *
 * @param {string[]} headers every WWW-Authenticate header value received
 * @returns {{ scheme: 'digest', realm: string, nonce: string, qop?: string, opaque?: string,
 *   algorithm: string, stale: boolean } | { scheme: 'basic', realm?: string } | null}
 */
export function parseChallenge(headers) {
  let basic = null;
  for (const header of headers ?? []) {
    // A server may put several challenges in one header: cut at each scheme.
    for (const part of String(header).split(/,?\s*(?=\b(?:Digest|Basic)\s)/i)) {
      const scheme = /^\s*(Digest|Basic)\s/i.exec(part)?.[1]?.toLowerCase();
      if (!scheme) {
        continue;
      }
      const params = {};
      for (const [, key, quoted, bare] of part.matchAll(
        /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g,
      )) {
        params[key.toLowerCase()] = (quoted ?? bare).replace(/\\(.)/g, '$1');
      }
      if (scheme === 'digest' && params.nonce) {
        // A Digest challenge wins over Basic: the password never travels.
        return {
          scheme: 'digest',
          realm: params.realm ?? '',
          nonce: params.nonce,
          qop: params.qop,
          opaque: params.opaque,
          algorithm: (params.algorithm ?? 'MD5').toUpperCase(),
          stale: String(params.stale).toLowerCase() === 'true',
        };
      }
      if (scheme === 'basic') {
        basic = { scheme: 'basic', realm: params.realm };
      }
    }
  }
  return basic;
}

function hasher(algorithm) {
  const base = algorithm.toLowerCase().replace(/-sess$/, '');
  const name = HASHES[base];
  if (!name) {
    throw new Error(`Unsupported digest algorithm ${algorithm}`);
  }
  return (text) => createHash(name).update(text).digest('hex');
}

/**
 * Build the Authorization header answering a challenge.
 *
 * @param {ReturnType<typeof parseChallenge>} challenge parsed challenge
 * @param {{ username: string, password: string, method: string, uri: string,
 *   nc?: number, cnonce?: string }} request what is being authorized
 * @returns {string}
 */
export function buildAuthorization(challenge, { username, password, method, uri, nc = 1, cnonce }) {
  if (challenge.scheme === 'basic') {
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  }
  const hash = hasher(challenge.algorithm);
  const clientNonce = cnonce ?? randomBytes(8).toString('hex');
  const nonceCount = nc.toString(16).padStart(8, '0');
  // qop may list several values: "auth" is the one that covers no body.
  const qop = challenge.qop
    ?.split(',')
    .map((value) => value.trim())
    .includes('auth')
    ? 'auth'
    : undefined;

  let ha1 = hash(`${username}:${challenge.realm}:${password}`);
  if (/-sess$/i.test(challenge.algorithm)) {
    ha1 = hash(`${ha1}:${challenge.nonce}:${clientNonce}`);
  }
  const ha2 = hash(`${method}:${uri}`);
  const response = qop
    ? hash(`${ha1}:${challenge.nonce}:${nonceCount}:${clientNonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${challenge.nonce}:${ha2}`);

  const quote = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const fields = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
    `algorithm=${challenge.algorithm}`,
    `response=${quote(response)}`,
  ];
  if (challenge.opaque !== undefined) {
    fields.push(`opaque=${quote(challenge.opaque)}`);
  }
  if (qop) {
    fields.push(`qop=${qop}`, `nc=${nonceCount}`, `cnonce=${quote(clientNonce)}`);
  }
  return `Digest ${fields.join(', ')}`;
}
