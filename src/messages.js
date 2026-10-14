// -----------------------------------------------------------------------------
// The words the integration shows to people, in the four languages of the
// Gladys interface (see src/i18n.js): event names, failure explanations,
// relative times. Logs stay in English; these never reach a log line.
// -----------------------------------------------------------------------------

import { localize, pick } from './i18n.js';

/** Event keys (src/hikvision/events.js) as people say them. */
export const EVENT_LABELS = {
  motion: { en: 'Motion', fr: 'Mouvement', de: 'Bewegung', es: 'Movimiento' },
  line_crossing: {
    en: 'Line crossing',
    fr: 'Franchissement de ligne',
    de: 'Linienüberschreitung',
    es: 'Cruce de línea',
  },
  intrusion: { en: 'Intrusion', fr: 'Intrusion', de: 'Eindringen', es: 'Intrusión' },
  region_entrance: {
    en: 'Region entrance',
    fr: 'Entrée dans une zone',
    de: 'Bereichseintritt',
    es: 'Entrada en zona',
  },
  region_exiting: {
    en: 'Region exiting',
    fr: "Sortie d'une zone",
    de: 'Bereichsaustritt',
    es: 'Salida de zona',
  },
  tamper: { en: 'Tampering', fr: 'Sabotage', de: 'Sabotage', es: 'Sabotaje' },
  face: { en: 'Face', fr: 'Visage', de: 'Gesicht', es: 'Rostro' },
  scene_change: {
    en: 'Scene change',
    fr: 'Changement de scène',
    de: 'Szenenwechsel',
    es: 'Cambio de escena',
  },
  unattended_object: {
    en: 'Unattended object',
    fr: 'Objet abandonné',
    de: 'Zurückgelassenes Objekt',
    es: 'Objeto abandonado',
  },
  object_removal: {
    en: 'Object removed',
    fr: 'Objet retiré',
    de: 'Entferntes Objekt',
    es: 'Objeto retirado',
  },
  pir: { en: 'PIR', fr: 'PIR', de: 'PIR', es: 'PIR' },
  video_loss: { en: 'Video loss', fr: 'Perte vidéo', de: 'Videoverlust', es: 'Pérdida de vídeo' },
  alarm_input: {
    en: 'Alarm input',
    fr: "Entrée d'alarme",
    de: 'Alarmeingang',
    es: 'Entrada de alarma',
  },
};

/** Detection kinds (src/hikvision/isapi.js) in a sentence. */
export const DETECTION_LABELS = {
  motion: { en: 'motion', fr: 'mouvement', de: 'Bewegung', es: 'movimiento' },
  line_crossing: {
    en: 'line crossing',
    fr: 'franchissement de ligne',
    de: 'Linienüberschreitung',
    es: 'cruce de línea',
  },
  intrusion: { en: 'intrusion', fr: 'intrusion', de: 'Eindringen', es: 'intrusión' },
  tamper: { en: 'tampering', fr: 'sabotage', de: 'Sabotage', es: 'sabotaje' },
};

/**
 * Why a device does not answer, in words a user can act on.
 * @param {{ code?: string, message?: string, retryLoginTime?: number } | null} error
 * @returns {Record<string, string>} `{ en, fr, de, es }`
 */
export function explainError(error) {
  const left = error?.retryLoginTime;
  switch (error?.code) {
    case 'unreachable':
      return {
        en: 'unreachable: check the address, the port and that the device is on the network',
        fr: "injoignable : vérifiez l'adresse, le port et que l'appareil est bien sur le réseau",
        de: 'nicht erreichbar: Prüfe Adresse, Port und ob das Gerät im Netzwerk ist',
        es: 'inaccesible: compruebe la dirección, el puerto y que el dispositivo esté en la red',
      };
    case 'timeout':
      return {
        en: 'no answer within 10 seconds',
        fr: 'aucune réponse en 10 secondes',
        de: 'keine Antwort innerhalb von 10 Sekunden',
        es: 'sin respuesta en 10 segundos',
      };
    case 'tls':
      return {
        en: 'HTTPS refused: untick "Check the HTTPS certificate", or check http:// or https:// in the address',
        fr: "HTTPS refusé : décochez « Vérifier le certificat HTTPS », ou vérifiez http:// ou https:// dans l'adresse",
        de: 'HTTPS abgelehnt: Deaktiviere „HTTPS-Zertifikat prüfen“ oder prüfe http:// bzw. https:// in der Adresse',
        es: 'HTTPS rechazado: desmarque «Comprobar el certificado HTTPS», o revise http:// o https:// en la dirección',
      };
    case 'auth':
      return localize((language) => {
        const base = pick(language, {
          en: 'user name or password refused. The device locks the account after a few failures: it is not retried until you save the configuration again',
          fr: "nom d'utilisateur ou mot de passe refusé. L'appareil bloque le compte après quelques échecs : rien n'est retenté avant que vous enregistriez à nouveau la configuration",
          de: 'Benutzername oder Passwort abgelehnt. Das Gerät sperrt das Konto nach einigen Fehlversuchen: Es wird erst wieder versucht, wenn du die Konfiguration erneut speicherst',
          es: 'usuario o contraseña rechazados. El dispositivo bloquea la cuenta tras varios fallos: no se reintenta hasta que vuelva a guardar la configuración',
        });
        if (!Number.isFinite(left) || left <= 0) {
          return base;
        }
        return `${base} (${pick(language, {
          en: `${left} attempt(s) left`,
          fr: `${left} essai(s) restant(s)`,
          de: `noch ${left} Versuch(e)`,
          es: `quedan ${left} intento(s)`,
        })})`;
      });
    case 'locked':
      return {
        en: 'account locked by the device after failed logins: wait about 30 minutes, check the password, then save the configuration',
        fr: "compte bloqué par l'appareil après des échecs de connexion : attendez environ 30 minutes, vérifiez le mot de passe, puis enregistrez la configuration",
        de: 'Konto nach fehlgeschlagenen Anmeldungen vom Gerät gesperrt: Warte etwa 30 Minuten, prüfe das Passwort und speichere dann die Konfiguration',
        es: 'cuenta bloqueada por el dispositivo tras inicios de sesión fallidos: espere unos 30 minutos, compruebe la contraseña y guarde la configuración',
      };
    case 'forbidden':
      return {
        en: 'this user lacks the rights: give it the Operator (or Administrator) role on the device',
        fr: "cet utilisateur n'a pas les droits : donnez-lui le rôle Opérateur (ou Administrateur) sur l'appareil",
        de: 'diesem Benutzer fehlen die Rechte: Gib ihm auf dem Gerät die Rolle Bediener (oder Administrator)',
        es: 'este usuario no tiene permisos: asígnele el rol Operador (o Administrador) en el dispositivo',
      };
    case 'not_supported':
      return {
        en: 'the device does not answer the ISAPI: enable it in Network > Advanced > Integration protocol',
        fr: "l'appareil ne répond pas à l'ISAPI : activez-la dans Réseau > Avancé > Protocole d'intégration",
        de: 'das Gerät beantwortet die ISAPI nicht: Aktiviere sie unter Netzwerk > Erweitert > Integrationsprotokoll',
        es: 'el dispositivo no responde a la ISAPI: actívela en Red > Avanzado > Protocolo de integración',
      };
    case 'too_large':
      return {
        en: 'the snapshot is over the 150 KB Gladys accepts: lower the sub-stream resolution of the camera',
        fr: "l'image dépasse les 150 Ko acceptés par Gladys : baissez la résolution du flux secondaire de la caméra",
        de: 'das Bild ist größer als die 150 KB, die Gladys annimmt: Senke die Auflösung des Substreams der Kamera',
        es: 'la imagen supera los 150 KB que acepta Gladys: baje la resolución del flujo secundario de la cámara',
      };
    default:
      return localize(
        (language) =>
          `${pick(language, {
            en: 'unexpected answer',
            fr: 'réponse inattendue',
            de: 'unerwartete Antwort',
            es: 'respuesta inesperada',
          })}: ${error?.message ?? '?'}`,
      );
  }
}

/**
 * "5 min ago", in one language.
 * @param {string} language
 * @param {number} ageMs elapsed milliseconds
 */
export function timeAgo(language, ageMs) {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) {
    return pick(language, {
      en: 'just now',
      fr: "à l'instant",
      de: 'gerade eben',
      es: 'ahora mismo',
    });
  }
  if (minutes < 60) {
    return pick(language, {
      en: `${minutes} min ago`,
      fr: `il y a ${minutes} min`,
      de: `vor ${minutes} Min.`,
      es: `hace ${minutes} min`,
    });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return pick(language, {
      en: `${hours} h ago`,
      fr: `il y a ${hours} h`,
      de: `vor ${hours} Std.`,
      es: `hace ${hours} h`,
    });
  }
  const days = Math.floor(hours / 24);
  return pick(language, {
    en: `${days} d ago`,
    fr: `il y a ${days} j`,
    de: `vor ${days} T.`,
    es: `hace ${days} d`,
  });
}
