// -----------------------------------------------------------------------------
// The log level, switchable from the Configuration screen.
//
// The SDK logger re-reads `process.env.LOG_LEVEL` on every line, so writing
// that variable takes effect at once, for every logger already created (the
// SDK's own connection logs included): no restart, nothing to rebuild.
//
// An operator who set `LOG_LEVEL` on the container keeps it as the baseline:
// the switch raises the level to debug while it is on, and puts their value
// back — not `info` — when it goes off.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'logging' });

/** `LOG_LEVEL` as the container was started with, read once. */
const BASELINE = process.env.LOG_LEVEL;

/**
 * Apply the log level a configuration asks for.
 * @param {{ debug_logs?: boolean }} config normalized configuration
 * @returns {string} the level in force afterwards
 */
export function applyLogLevel(config) {
  const wanted = config?.debug_logs ? 'debug' : BASELINE;
  const before = process.env.LOG_LEVEL;
  if (wanted === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = wanted;
  }
  // Said at info, so both lines survive the level they announce.
  if (before !== process.env.LOG_LEVEL) {
    logger.info(
      config?.debug_logs
        ? 'Detailed logs turned on: every camera event is logged'
        : `Detailed logs turned off (level: ${process.env.LOG_LEVEL ?? 'info'})`,
    );
  }
  return process.env.LOG_LEVEL ?? 'info';
}
