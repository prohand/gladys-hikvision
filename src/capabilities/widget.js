// -----------------------------------------------------------------------------
// The "Hikvision" dashboard widget (SDK v0.14+, Gladys 5.1+).
//
// At a glance: how many cameras answer, how many detections in 24 hours, the
// image of one camera (the one chosen in the widget settings, else the one
// that detected something last), and one line per camera with its last
// detection. Three buttons: a fresh snapshot, and disarm / arm every
// detection of every camera (asked to confirm: it is the alarm).
//
// The content is declarative; the core renders it with its own theme and
// picks the language. Images are served by `onWidgetGetImage`, keyed by a hash
// of their bytes (the core caches an image one hour per key).
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { localize, pick } from '../i18n.js';
import { EVENT_LABELS, timeAgo } from '../messages.js';
import { WIDGET_KEY } from '../hub.js';

const logger = createLogger({ name: 'widget' });

export const WIDGET_ACTIONS = { SNAPSHOT: 'snapshot', DISARM: 'disarm', ARM: 'arm' };

const MAX_STATUS_ROWS = 10;
// An image this old is captured again when the widget is drawn.
const WIDGET_IMAGE_MAX_AGE_MS = 5 * 60 * 1000;
const WIDGET_IMAGE_TIMEOUT_MS = 8_000;

function clip(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** The camera the image shows. */
function chooseCamera(cameras, settings) {
  const chosen = cameras.find((camera) => camera.externalId === settings?.camera);
  if (chosen) return chosen;
  const usable = cameras.filter((camera) => camera.online && camera.enabled);
  const withEvents = usable
    .filter((camera) => camera.lastEvent)
    .sort((a, b) => b.lastEvent.at - a.lastEvent.at);
  return withEvents[0] ?? usable[0];
}

async function imageOf(hub, camera) {
  // A camera disabled in Gladys shows no image anywhere, the widget included.
  if (!camera?.online || !camera.enabled) {
    return undefined;
  }
  let timer;
  try {
    return await Promise.race([
      hub.captureImage(camera.externalId, WIDGET_IMAGE_MAX_AGE_MS),
      new Promise((resolve) => {
        timer = setTimeout(resolve, WIDGET_IMAGE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.debug(`Widget image of ${camera.name}: ${error.message}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function cameraRow(hub, camera) {
  if (!camera.enabled) {
    return {
      label: clip(camera.name, 40),
      icon: 'eye-off',
      value: {
        en: 'Disabled in Gladys',
        fr: 'Désactivée dans Gladys',
        de: 'In Gladys deaktiviert',
        es: 'Desactivada en Gladys',
      },
      color: WIDGET_COLORS.NEUTRAL,
    };
  }
  if (!camera.online) {
    return {
      label: clip(camera.name, 40),
      icon: 'video-off',
      value: { en: 'Offline', fr: 'Hors ligne', de: 'Offline', es: 'Desconectada' },
      color: WIDGET_COLORS.DANGER,
    };
  }
  const last = camera.lastEvent;
  return {
    label: clip(camera.name, 40),
    icon: 'video',
    value: last
      ? localize((language) =>
          clip(
            `${pick(language, EVENT_LABELS[last.key])} · ${timeAgo(language, hub.now() - last.at)}`,
            40,
          ),
        )
      : {
          en: 'No detection',
          fr: 'Aucune détection',
          de: 'Keine Erkennung',
          es: 'Sin detección',
        },
    color: last ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
  };
}

/**
 * @param {() => import('../hub.js').Hub} getHub the current hub
 */
export function createWidgets(getHub) {
  return {
    [WIDGET_KEY]: {
      async get({ settings }) {
        const hub = getHub();
        const cameras = hub.cameras();
        const online = cameras.filter((camera) => camera.online).length;
        const components = [
          {
            type: 'value',
            label: {
              en: 'Cameras online',
              fr: 'Caméras en ligne',
              de: 'Kameras online',
              es: 'Cámaras en línea',
            },
            icon: 'video',
            value: `${online}/${cameras.length}`,
            color: online === cameras.length ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING,
          },
          {
            type: 'value',
            label: {
              en: 'Detections (24 h)',
              fr: 'Détections (24 h)',
              de: 'Erkennungen (24 h)',
              es: 'Detecciones (24 h)',
            },
            icon: 'activity',
            value: hub.recentEventCount(),
            color: WIDGET_COLORS.NEUTRAL,
          },
        ];

        const camera = chooseCamera(cameras, settings);
        const image = await imageOf(hub, camera);
        if (image) {
          components.push({
            type: 'image',
            key: image.key,
            alt: clip(camera.name, 100),
            fit: 'contain',
          });
        }

        if (cameras.length > 0) {
          components.push({
            type: 'status',
            items: cameras.slice(0, MAX_STATUS_ROWS).map((entry) => cameraRow(hub, entry)),
          });
        } else {
          components.push({
            type: 'text',
            variant: 'body',
            text: {
              en: 'No camera yet: check the configuration of the Hikvision integration.',
              fr: "Aucune caméra pour l'instant : vérifiez la configuration de l'intégration Hikvision.",
              de: 'Noch keine Kamera: Prüfe die Konfiguration der Hikvision-Integration.',
              es: 'Aún no hay cámaras: revise la configuración de la integración Hikvision.',
            },
          });
        }

        if (camera?.online && camera.enabled) {
          components.push({
            type: 'button',
            label: { en: 'Snapshot', fr: 'Instantané', de: 'Schnappschuss', es: 'Instantánea' },
            icon: 'camera',
            style: 'primary',
            action: { key: WIDGET_ACTIONS.SNAPSHOT, params: { device: camera.externalId } },
          });
        }
        if (online > 0) {
          components.push(
            {
              type: 'button',
              label: { en: 'Disarm', fr: 'Désarmer', de: 'Deaktivieren', es: 'Desarmar' },
              icon: 'bell-off',
              style: 'danger',
              action: { key: WIDGET_ACTIONS.DISARM, confirm: true },
            },
            {
              type: 'button',
              label: { en: 'Arm', fr: 'Armer', de: 'Aktivieren', es: 'Armar' },
              icon: 'bell',
              style: 'secondary',
              action: { key: WIDGET_ACTIONS.ARM, confirm: true },
            },
          );
        }
        // The computed rows follow events and health checks, which nudge the
        // widget themselves: the TTL is a safety net.
        return { ttl_seconds: 120, components };
      },

      async action({ actionKey, params }) {
        const hub = getHub();
        if (actionKey === WIDGET_ACTIONS.SNAPSHOT) {
          await hub.snapshotNow(params.device);
          return {
            en: 'Snapshot taken',
            fr: 'Instantané pris',
            de: 'Schnappschuss aufgenommen',
            es: 'Instantánea tomada',
          };
        }
        if (actionKey === WIDGET_ACTIONS.DISARM || actionKey === WIDGET_ACTIONS.ARM) {
          const enabled = actionKey === WIDGET_ACTIONS.ARM;
          const { changed, failed } = await hub.setAllDetections(enabled);
          if (changed === 0 && failed > 0) {
            throw new Error('No detection could be changed: check the integration logs');
          }
          return localize((language) => {
            const done = pick(
              language,
              enabled
                ? {
                    en: 'Detections on',
                    fr: 'Détections activées',
                    de: 'Erkennungen an',
                    es: 'Detecciones activadas',
                  }
                : {
                    en: 'Detections off',
                    fr: 'Détections désactivées',
                    de: 'Erkennungen aus',
                    es: 'Detecciones desactivadas',
                  },
            );
            const errors =
              failed > 0
                ? pick(language, {
                    en: ` (${failed} failed)`,
                    fr: ` (${failed} en échec)`,
                    de: ` (${failed} fehlgeschlagen)`,
                    es: ` (${failed} fallidas)`,
                  })
                : '';
            return `${done}: ${changed}${errors}`;
          });
        }
        throw new Error(`Unknown widget action: ${actionKey}`);
      },
    },
  };
}

/** onWidgetGetImage: the raw base64 of an image key the content declared. */
export function widgetImage(hub, imageKey) {
  const image = hub.imageByKey(imageKey);
  if (!image) {
    throw new Error(`Image ${imageKey} is no longer available`);
  }
  return image.buffer.toString('base64');
}
