// -----------------------------------------------------------------------------
// What the integration remembers between two runs, in /data (the only
// writable path of the container): the last discovery of each address, and
// the cameras the user disabled in Gladys (the `enabled` feature).
//
// A camera that is off when the integration starts cannot be asked what it
// is; without this file its Gladys devices would be unknown until it comes
// back — no "offline" badge, no clear error on a command. Nothing secret is
// stored: identity, channels, contacts, the paths of the detection settings.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'store' });

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = 'stations.json';
const DISABLED_FILE = 'disabled-cameras.json';

/**
 * @param {string} [dir] directory, /data by default
 * @returns {Promise<Record<string, object>>} base URL -> station state
 */
export async function loadStations(dir = DATA_DIR) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn(`Cannot read ${FILE}, starting without it: ${error.message}`);
    }
    return {};
  }
}

/** Write atomically (a temporary file renamed), so a crash never leaves half a file. */
async function writeAtomically(dir, file, value) {
  try {
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, `${file}.tmp`);
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, join(dir, file));
  } catch (error) {
    logger.warn(`Cannot write ${file}: ${error.message}`);
  }
}

/**
 * @param {Record<string, object>} stations base URL -> station state
 * @param {string} [dir] directory, /data by default
 */
export function saveStations(stations, dir = DATA_DIR) {
  return writeAtomically(dir, FILE, stations);
}

/**
 * The cameras disabled in Gladys, by platform id (`<serial>-<channel>`, the
 * stable part of the external id). A camera is enabled unless listed: a lost
 * file never hides a camera.
 * @param {string} [dir] directory, /data by default
 * @returns {Promise<Set<string>>}
 */
export async function loadDisabledCameras(dir = DATA_DIR) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, DISABLED_FILE), 'utf8'));
    const list = Array.isArray(parsed?.disabled) ? parsed.disabled : [];
    return new Set(list.filter((id) => typeof id === 'string'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn(`Cannot read ${DISABLED_FILE}, every camera enabled: ${error.message}`);
    }
    return new Set();
  }
}

/**
 * @param {Set<string>} disabled platform ids
 * @param {string} [dir] directory, /data by default
 */
export function saveDisabledCameras(disabled, dir = DATA_DIR) {
  return writeAtomically(dir, DISABLED_FILE, { disabled: [...disabled].sort() });
}
