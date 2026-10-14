// -----------------------------------------------------------------------------
// Entry point of the Hikvision integration for Gladys Assistant.
//
// This file only wires the SDK to the hub (src/hub.js): every handler is
// registered BEFORE connect(), then the integration connects. No camera logic
// here.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them itself.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { applyLogLevel } from './src/logging.js';
import { Hub } from './src/hub.js';
import { testConnection } from './src/connection.js';
import { createSceneActions } from './src/capabilities/scenes.js';
import { createWidgets, widgetImage } from './src/capabilities/widget.js';

/**
 * Register every handler on a Gladys client. Exported for the tests, which
 * pass the SDK's fake Gladys.
 * @param {GladysIntegration} gladys
 * @param {ConstructorParameters<typeof Hub>[1]} [deps] test seams of the hub
 * @returns {{ hub: Hub }}
 */
export function register(gladys, deps) {
  const hub = new Hub(gladys, deps);
  const getHub = () => hub;

  // Serialize the (re)starts: a configuration saved during a reconnection
  // must not run two hubs side by side.
  let restarting = Promise.resolve();
  const restart = (rawConfig) => {
    restarting = restarting
      .catch(() => {})
      .then(async () => {
        const config = normalizeConfig(rawConfig);
        applyLogLevel(config);
        await hub.start(config);
      });
    return restarting;
  };

  // --- Discovery -------------------------------------------------------------
  gladys.onScanRequest(async () => {
    await gladys.publishDiscoveredDevices(hub.discoveredDevices());
  });

  // --- Commands: detection switches, alarm outputs, PTZ ------------------------
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    await hub.setValue(device, feature, value);
  });

  // --- Camera image: Gladys wants a FRESH capture (acked under 15 s) -----------
  gladys.onGetImage(async (device) => hub.getImage(device.external_id));

  // --- A device created in Gladys gets its known states at once ---------------
  gladys.onDeviceCreated(async () => hub.republishStates());

  // --- Configuration screen buttons --------------------------------------------
  gladys.onAction('test_connection', () => testConnection(hub));

  // --- Scene actions (Gladys 5.1+) ---------------------------------------------
  for (const [key, handler] of Object.entries(createSceneActions(getHub))) {
    gladys.onSceneAction(key, (fields) => handler(fields));
  }

  // --- Dashboard widget (Gladys 5.1+) ------------------------------------------
  for (const [key, widget] of Object.entries(createWidgets(getHub))) {
    gladys.onWidgetGet(key, (request) => widget.get(request));
    gladys.onWidgetAction(key, (actionKey, params, { settings }) =>
      widget.action({ actionKey, params, settings }),
    );
  }
  gladys.onWidgetGetImage(async (imageKey) => widgetImage(hub, imageKey));

  // --- Configuration saved by the user -----------------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('Configuration updated: restarting the connections to the devices');
    try {
      await restart(newConfig);
    } catch (error) {
      logger.error('Restart after a configuration change failed', error);
      await failed(gladys);
    }
  });

  // --- Connection lifecycle ----------------------------------------------------
  gladys.on('connected', async () => {
    try {
      await restart(await gladys.getConfig());
    } catch (error) {
      logger.error('Post-connection initialization failed', error);
      await failed(gladys);
    }
  });

  gladys.handleShutdown(async (signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    await hub.stop();
  });

  return { hub };
}

function failed(gladys) {
  return gladys
    .setConnectionStatus(false, {
      en: 'Initialization failed, check the integration logs.',
      fr: "L'initialisation a échoué, consultez les journaux de l'intégration.",
      de: 'Initialisierung fehlgeschlagen, prüfe die Protokolle der Integration.',
      es: 'La inicialización ha fallado, consulte los registros de la integración.',
    })
    .catch(() => {});
}

// --- Startup (not when imported by the tests) ---------------------------------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.on('unhandledRejection', (error) => logger.error('Unhandled rejection', error));
  const gladys = new GladysIntegration();
  register(gladys);
  logger.info('Starting the Hikvision integration...');
  gladys.connect().catch((error) => {
    logger.error('Initial connection failed', error);
    process.exit(1);
  });
}
