// -----------------------------------------------------------------------------
// Configuration: the address list and the bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseHost, parseHosts } from '../src/config.js';

test('addresses: plain, with a port, https, IPv6, names', () => {
  assert.deepEqual(parseHost('192.168.1.64'), {
    protocol: 'http:',
    hostname: '192.168.1.64',
    port: 80,
    label: '192.168.1.64',
    baseUrl: 'http://192.168.1.64:80',
  });
  assert.equal(parseHost('192.168.1.64:8080').label, '192.168.1.64:8080');
  assert.equal(parseHost('https://nvr.local').baseUrl, 'https://nvr.local:443');
  assert.equal(parseHost('https://nvr.local').label, 'https://nvr.local');
  assert.equal(parseHost('[fe80::1]:81').baseUrl, 'http://[fe80::1]:81');
  assert.equal(parseHost('ftp://cam'), null);
  assert.equal(parseHost('bad!host'), null);
});

test('credentials typed in an address are refused, never echoed', () => {
  assert.equal(parseHost('http://admin:pw@192.168.1.64'), null);
  const { hosts, invalid } = parseHosts('admin:pw@192.168.1.64, 192.168.1.65');
  assert.equal(hosts.length, 1);
  assert.deepEqual(invalid, ['(address with credentials)']);
});

test('a list in any separator, without duplicates', () => {
  const { hosts, invalid } = parseHosts(
    '192.168.1.64, 192.168.1.65;192.168.1.64\nhttp://192.168.1.66:80/ ',
  );
  assert.deepEqual(
    hosts.map((host) => host.label),
    ['192.168.1.64', '192.168.1.65', '192.168.1.66'],
  );
  assert.deepEqual(invalid, []);
  assert.deepEqual(parseHosts('').hosts, []);
});

test('numbers are bounded, the snapshot interval is 0 or at least 10 s', () => {
  const config = normalizeConfig({
    snapshot_interval: '3',
    event_hold: 1000,
    refresh_interval: 'x',
    snapshot_stream: 'other',
  });
  assert.equal(config.snapshot_interval, 10);
  assert.equal(config.event_hold, 300);
  assert.equal(config.refresh_interval, DEFAULT_CONFIG.refresh_interval);
  assert.equal(config.snapshot_stream, 'sub');
  assert.equal(normalizeConfig({ snapshot_interval: 0 }).snapshot_interval, 0);
  assert.equal(normalizeConfig({ username: '  ' }).username, 'admin');
  assert.equal(normalizeConfig(null).verify_tls, false);
});
