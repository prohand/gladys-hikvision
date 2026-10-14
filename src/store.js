// -----------------------------------------------------------------------------
// What the integration remembers between two runs, in /data (the only
// writable path of the container): the last discovery of each address.
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

/**
 * Write atomically (a temporary file renamed), so a crash never leaves half a file.
 * @param {Record<string, object>} stations base URL -> station state
 * @param {string} [dir] directory, /data by default
 */
export async function saveStations(stations, dir = DATA_DIR) {
  try {
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, `${FILE}.tmp`);
    await writeFile(temporary, JSON.stringify(stations, null, 2));
    await rename(temporary, join(dir, FILE));
  } catch (error) {
    logger.warn(`Cannot write ${FILE}: ${error.message}`);
  }
}
