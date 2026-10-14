// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys, from the `config_schema` of
// `gladys-assistant-integration.json`. This module provides the defaults and
// turns the raw object into one the rest of the code can trust: numbers are
// numbers, bounds are applied, and the list of addresses is parsed once.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  hosts: '',
  username: 'admin',
  password: '',
  verify_tls: false,
  // Seconds between two snapshots pushed to Gladys, per camera. 0 turns the
  // periodic snapshots off (Gladys still asks for a fresh one when needed).
  snapshot_interval: 60,
  // 'sub' (light, recommended) or 'main' (full resolution, often over the
  // 150 KB Gladys accepts: the sub-stream is then used instead).
  snapshot_stream: 'sub',
  // Seconds a detection stays "on" after the last event the camera sent.
  event_hold: 10,
  // Seconds between two health checks (reachability, channel status, alarm
  // outputs, detection switches).
  refresh_interval: 60,
  debug_logs: false,
};

/** Bounds of the number fields, the same as the manifest `min` / `max`. */
const BOUNDS = {
  snapshot_interval: { min: 0, max: 3600 },
  event_hold: { min: 2, max: 300 },
  refresh_interval: { min: 30, max: 3600 },
};

// Gladys admits 12 images a minute per camera: one every 5 s. Below 10 s the
// camera spends its time encoding snapshots nobody looks at.
const MIN_SNAPSHOT_INTERVAL = 10;

/**
 * A number field, as a number within its bounds (the form may send strings).
 * @param {unknown} value raw value
 * @param {string} key config key, see DEFAULT_CONFIG and BOUNDS
 */
function toNumber(value, key) {
  const number = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(number)) {
    return DEFAULT_CONFIG[key];
  }
  const { min, max } = BOUNDS[key];
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Parse one address of the `hosts` field.
 *
 * Accepted forms: `192.168.1.64`, `192.168.1.64:8080`, `cam.local`,
 * `https://192.168.1.64`, `http://192.168.1.64:8000/`, `[fe80::1]:80`.
 *
 * @param {string} entry one address, trimmed
 * @returns {{ protocol: 'http:' | 'https:', hostname: string, port: number, label: string, baseUrl: string } | null}
 *   null when the entry is not an address
 */
export function parseHost(entry) {
  const text = entry.trim();
  if (!text) {
    return null;
  }
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // A host name, an IPv4 or a bracketed IPv6: nothing else is an address.
  if (
    !/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i.test(
      url.hostname,
    )
  ) {
    return null;
  }
  // Credentials typed in the address would end up in the logs: they belong in
  // the user name and password fields.
  if (url.username || url.password) {
    return null;
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const hostPart = url.hostname;
  const label = port === defaultPort ? hostPart : `${hostPart}:${port}`;
  return {
    protocol: url.protocol,
    hostname: hostPart,
    port,
    label: url.protocol === 'https:' ? `https://${label}` : label,
    baseUrl: `${url.protocol}//${hostPart}:${port}`,
  };
}

/**
 * Parse the `hosts` field: addresses separated by commas, semicolons, spaces
 * or new lines. Duplicates are dropped.
 *
 * @param {string} text the raw field
 * @returns {{ hosts: ReturnType<typeof parseHost>[], invalid: string[] }}
 */
export function parseHosts(text) {
  const hosts = [];
  const invalid = [];
  const seen = new Set();
  for (const entry of String(text ?? '').split(/[\s,;]+/)) {
    if (!entry) {
      continue;
    }
    const host = parseHost(entry);
    if (!host) {
      // Never echo back something that may hold a password.
      invalid.push(entry.includes('@') ? '(address with credentials)' : entry);
      continue;
    }
    if (!seen.has(host.baseUrl)) {
      seen.add(host.baseUrl);
      hosts.push(host);
    }
  }
  return { hosts, invalid };
}

/**
 * Merge the user config with the defaults and normalize it.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw ?? {};
  const snapshotInterval = toNumber(source.snapshot_interval, 'snapshot_interval');
  const { hosts, invalid } = parseHosts(source.hosts ?? DEFAULT_CONFIG.hosts);
  return {
    ...DEFAULT_CONFIG,
    ...source,
    hosts: String(source.hosts ?? DEFAULT_CONFIG.hosts),
    username: String(source.username ?? '').trim() || DEFAULT_CONFIG.username,
    password: typeof source.password === 'string' ? source.password : DEFAULT_CONFIG.password,
    verify_tls: source.verify_tls === true,
    snapshot_interval:
      snapshotInterval === 0 ? 0 : Math.max(MIN_SNAPSHOT_INTERVAL, snapshotInterval),
    snapshot_stream: source.snapshot_stream === 'main' ? 'main' : 'sub',
    event_hold: toNumber(source.event_hold, 'event_hold'),
    refresh_interval: toNumber(source.refresh_interval, 'refresh_interval'),
    debug_logs: source.debug_logs === true,
    // Parsed once, here: every other module reads these two.
    stations: hosts,
    invalidHosts: invalid,
  };
}
