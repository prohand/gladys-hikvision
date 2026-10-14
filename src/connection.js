// -----------------------------------------------------------------------------
// "Test the connection" (manifest action `test_connection`): one line per
// configured address, saying what answered and what Gladys gets from it — or
// why not, in words the user can act on.
//
// It is the one place that retries a device whose password was refused: the
// user pressed the button, after fixing it on the device for instance.
// -----------------------------------------------------------------------------

import { localize, pick } from './i18n.js';
import { DETECTION_LABELS, explainError } from './messages.js';

const STREAM_WAIT_MS = 3_000;

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line for a station that answered. */
function describeStation(language, station) {
  const { info, recorder, channels, io } = station;
  const kind = pick(
    language,
    recorder
      ? { en: 'recorder', fr: 'enregistreur', de: 'Rekorder', es: 'grabador' }
      : { en: 'camera', fr: 'caméra', de: 'Kamera', es: 'cámara' },
  );
  const parts = [
    `✅ ${station.label} — ${info.model || info.deviceName} (${kind}, ${info.firmwareVersion || '?'})`,
  ];

  if (recorder) {
    const online = channels.filter((channel) => channel.online).length;
    parts.push(
      pick(language, {
        en: `${plural(channels.length, 'camera', 'cameras')}, ${online} online`,
        fr: `${plural(channels.length, 'caméra', 'caméras')}, ${online} en ligne`,
        de: `${plural(channels.length, 'Kamera', 'Kameras')}, ${online} online`,
        es: `${plural(channels.length, 'cámara', 'cámaras')}, ${online} en línea`,
      }),
    );
  }

  const kinds = [...new Set(channels.flatMap((channel) => Object.keys(channel.detections)))];
  parts.push(
    pick(language, {
      en: 'detections: ',
      fr: 'détections : ',
      de: 'Erkennungen: ',
      es: 'detecciones: ',
    }) +
      (kinds.length > 0
        ? kinds.map((detection) => pick(language, DETECTION_LABELS[detection])).join(', ')
        : pick(language, {
            en: 'motion (setting not readable by this user)',
            fr: 'mouvement (réglage illisible pour cet utilisateur)',
            de: 'Bewegung (Einstellung für diesen Benutzer nicht lesbar)',
            es: 'movimiento (ajuste no legible para este usuario)',
          })),
  );

  const ptz = channels.filter((channel) => channel.ptz).length;
  if (ptz > 0) {
    parts.push(`PTZ: ${ptz}`);
  }

  parts.push(
    station.streamConnected
      ? pick(language, {
          en: 'events: received live',
          fr: 'événements : reçus en direct',
          de: 'Ereignisse: live empfangen',
          es: 'eventos: recibidos en directo',
        })
      : pick(language, {
          en: 'events: stream connecting (detections arrive once it is up)',
          fr: 'événements : flux en cours de connexion (les détections arrivent dès qu’il est établi)',
          de: 'Ereignisse: Stream verbindet sich (Erkennungen kommen, sobald er steht)',
          es: 'eventos: flujo conectándose (las detecciones llegan en cuanto esté activo)',
        }),
  );

  if (io.inputs.length > 0 || io.outputs.length > 0) {
    parts.push(
      pick(language, {
        en: `alarm I/O: ${io.inputs.length} in, ${io.outputs.length} out`,
        fr: `E/S d'alarme : ${io.inputs.length} entrée(s), ${io.outputs.length} sortie(s)`,
        de: `Alarm-E/A: ${io.inputs.length} Ein-, ${io.outputs.length} Ausgänge`,
        es: `E/S de alarma: ${io.inputs.length} entrada(s), ${io.outputs.length} salida(s)`,
      }),
    );
  }
  return parts.join(' · ');
}

/**
 * Handler of the `test_connection` manifest action.
 * @param {import('./hub.js').Hub} hub
 * @returns {Promise<Record<string, string>>} the message shown under the button
 */
export async function testConnection(hub) {
  const { stations, invalidHosts } = hub.config;
  if (stations.length === 0 && invalidHosts.length === 0) {
    return {
      en: 'No address yet: enter the address of your camera or recorder (e.g. 192.168.1.64), the user name and the password, then save.',
      fr: "Aucune adresse : saisissez l'adresse de votre caméra ou enregistreur (ex. 192.168.1.64), le nom d'utilisateur et le mot de passe, puis enregistrez.",
      de: 'Noch keine Adresse: Gib die Adresse deiner Kamera oder deines Rekorders (z. B. 192.168.1.64), den Benutzernamen und das Passwort ein und speichere.',
      es: 'Aún no hay dirección: introduzca la dirección de su cámara o grabador (p. ej. 192.168.1.64), el usuario y la contraseña, y guarde.',
    };
  }

  const results = [];
  for (const station of hub.stations) {
    results.push({ station, ok: await hub.retest(station) });
  }
  // The event stream opens right after a successful test: give it a moment,
  // so the report says whether detections really arrive.
  const deadline = Date.now() + STREAM_WAIT_MS;
  while (
    Date.now() < deadline &&
    results.some(({ station, ok }) => ok && !station.streamConnected && !station.authBlocked)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return localize((language) => {
    const lines = results.map(({ station, ok }) =>
      ok
        ? describeStation(language, station)
        : `❌ ${station.label} — ${pick(language, explainError(station.lastError))}`,
    );
    for (const entry of invalidHosts) {
      lines.push(
        `⚠️ ${entry} — ${pick(language, {
          en: 'not an address, ignored',
          fr: "ce n'est pas une adresse, ignoré",
          de: 'keine Adresse, ignoriert',
          es: 'no es una dirección, ignorado',
        })}`,
      );
    }
    return lines.join('\n');
  });
}
