// -----------------------------------------------------------------------------
// Digest authentication: the RFC example, and the challenges cameras send.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorization, parseChallenge } from '../src/hikvision/digest.js';

test('the RFC 2617 example gives the RFC response', () => {
  const challenge = parseChallenge([
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  ]);
  const header = buildAuthorization(challenge, {
    username: 'Mufasa',
    password: 'Circle Of Life',
    method: 'GET',
    uri: '/dir/index.html',
    nc: 1,
    cnonce: '0a4f113b',
  });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('Digest wins over Basic, in one header or in two', () => {
  const together = parseChallenge([
    'Basic realm="cam", Digest realm="cam", nonce="n1", qop="auth"',
  ]);
  assert.equal(together.scheme, 'digest');
  assert.equal(together.nonce, 'n1');
  const apart = parseChallenge(['Basic realm="cam"', 'Digest realm="cam", nonce="n2"']);
  assert.equal(apart.nonce, 'n2');
  assert.equal(apart.algorithm, 'MD5');
});

test('Basic alone gives a Basic header; nothing gives null', () => {
  const basic = parseChallenge(['Basic realm="cam"']);
  assert.equal(
    buildAuthorization(basic, { username: 'a', password: 'b', method: 'GET', uri: '/' }),
    `Basic ${Buffer.from('a:b').toString('base64')}`,
  );
  assert.equal(parseChallenge([]), null);
  assert.equal(parseChallenge(['Bearer x']), null);
});

test('a stale nonce is flagged, SHA-256 is supported', () => {
  const challenge = parseChallenge(['Digest realm="r", nonce="n", stale=TRUE, algorithm=SHA-256']);
  assert.equal(challenge.stale, true);
  const header = buildAuthorization(challenge, {
    username: 'u',
    password: 'p',
    method: 'GET',
    uri: '/',
  });
  assert.match(header, /algorithm=SHA-256/);
  assert.match(header, /response="[0-9a-f]{64}"/);
});
