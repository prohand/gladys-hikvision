# Hikvision für Gladys Assistant

Verbinde deine **Hikvision-IP-Kameras und -Rekorder (NVR / DVR)** mit Gladys, **in deinem lokalen
Netzwerk**: Kamerabilder, Erkennungen in Echtzeit (Bewegung, Linienüberschreitung, Eindringen,
Sabotage…), Alarmein- und -ausgänge, PTZ, Szenen und ein Dashboard-Widget.

- **Nur lokal**: Gladys spricht direkt über die ISAPI mit jedem Gerät. Kein Hik-Connect-Konto, keine
  Cloud, nichts am Router zu öffnen.
- **Ein Rekorder bringt alle seine Kameras mit**: Gib die Adresse des NVR ein, nicht die jeder
  angeschlossenen Kamera.

## Voraussetzungen

- Gladys **5.3 oder neuer**.
- Eine Hikvision-Kamera oder ein Rekorder im selben Netzwerk wie Gladys, mit fester IP-Adresse
  (DHCP-Reservierung).
- Ein Benutzerkonto auf diesem Gerät (siehe unten).

## 1. Das Gerät vorbereiten

In der Weboberfläche der Kamera oder des Rekorders:

1. **Lege einen eigenen Benutzer an**: _Konfiguration > System > Benutzerverwaltung > Hinzufügen_.
   Gib ihm die Rolle **Bediener**. Verwende nicht `admin`: Gladys braucht es nicht.
   - Damit Gladys Erkennungen ein- und ausschalten kann (aktivieren / deaktivieren), braucht der
     Benutzer das Recht, Parameter zu ändern („Parametereinstellungen“ / Fernkonfiguration).
2. **Aktiviere die ISAPI**: _Konfiguration > Netzwerk > Erweiterte Einstellungen >
   Integrationsprotokoll_ — **Hikvision-CGI aktivieren** mit **Digest**-Authentifizierung. Bei
   neueren Firmwares ist das standardmäßig aktiv.
3. **Notiere den HTTP-Port** (_Netzwerk > Grundeinstellungen > Port_), falls er nicht 80 ist.

> **Vorsicht mit Passwörtern**: Hikvision sperrt das Konto (oft 30 Minuten) nach einigen falschen
> Passwörtern. Die Integration versucht ein abgelehntes Passwort daher nie von selbst erneut:
> Korrigiere es und speichere die Konfiguration erneut (oder drücke **Verbindung testen**).

## 2. Die Integration konfigurieren

In Gladys: _Integrationen > Hikvision > Konfiguration_.

| Feld                          | Was eintragen                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adressen                      | IP-Adresse jeder Kamera bzw. jedes Rekorders, durch Kommas getrennt: `192.168.1.64, 192.168.1.70:8080`. `https://` für HTTPS voranstellen.       |
| Benutzername / Passwort       | Das oben angelegte Konto. Dasselbe Konto gilt für alle Geräte.                                                                                   |
| HTTPS-Zertifikat prüfen       | Aus lassen: Hikvision-Geräte haben ein selbstsigniertes Zertifikat.                                                                              |
| Bildintervall (s)             | Wie oft das Bild jeder Kamera in Gladys aktualisiert wird (Standard 60 s, mindestens 10 s, 0 = nur wenn Gladys es anfordert).                    |
| Bildqualität                  | **Substream** (empfohlen). Gladys nimmt Bilder bis 150 KB an; der Hauptstream wird auf 1280×720 verkleinert und ersetzt, wenn er zu groß bleibt. |
| Haltezeit einer Erkennung (s) | Wie lange eine Erkennung nach dem letzten Ereignis der Kamera „an“ bleibt (Standard 10 s).                                                       |
| Prüfintervall (s)             | Wie oft jedes Gerät geprüft wird (Standard 60 s).                                                                                                |
| Detaillierte Protokolle       | Zur Diagnose einschalten, danach wieder aus.                                                                                                     |

Speichere und drücke dann **Verbindung testen**: Eine Zeile pro Gerät nennt Modell, Firmware,
Kameras online, gefundene Erkennungen, ob Ereignisse live ankommen, sowie die Alarmein- und
-ausgänge. Bei einem Problem sagt die Zeile, was zu tun ist.

Öffne dann den Reiter **Entdecken** und lege die gewünschten Geräte an.

## 3. Die Geräte in Gladys

**Ein Gerät pro Kamera** (eine Kamera hat eines, ein Rekorder eines pro angeschlossener Kamera):

| Funktion                          | Typ             | Hinweise                                                                             |
| --------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| Bild                              | Kamera          | im Bildintervall aktualisiert und auf Anforderung                                    |
| In Gladys aktiviert               | Kamera          | aus: Gladys zeigt die Kamera, ihre Bilder und Erkennungen nicht mehr                 |
| Bewegung                          | Bewegungsmelder | immer vorhanden                                                                      |
| Linienüberschreitung / Eindringen | Bewegungsmelder | wenn die Kamera diese intelligenten Erkennungen kann                                 |
| Sabotage                          | Sabotage        | wenn die Kamera es kann                                                              |
| Bewegungserkennung / …            | Schalter        | schaltet diese Erkennung **auf der Kamera** ein oder aus (aktivieren / deaktivieren) |
| PTZ                               | Kamerabewegung  | nur PTZ-Kameras: kurze Schwenk-, Neige- und Zoomschritte, immer gestoppt             |
| Preset                            | Kamera-Preset   | PTZ-Kameras mit gespeicherten Positionen: Die Liste kommt von der Kamera             |

**Ein Gerät „alarm I/O“ pro Kamera oder Rekorder mit potenzialfreien Kontakten**: Jeder
**Alarmeingang** ist ein binärer Eingang (1, solange er im Alarm ist), jeder **Alarmausgang**
(Relais, Sirene) ist ein Schalter.

**In Gladys aktiviert** ist ein Privatsphäre-Schalter auf der Seite von Gladys: ausgeschaltet
verschwindet die Kamera aus dem Dashboard und den Szenen (kein Bild, keine Erkennung, kein
Szenen-Ereignis), nimmt aber selbst weiter auf. Die Wahl übersteht einen Neustart. Bei einem Gerät,
das vor dieser Funktion angelegt wurde, klicke im Reiter **Entdecken** auf **Aktualisieren**, um sie
hinzuzufügen.

Jedes Gerät zeigt ein Abzeichen **lokal**, wenn es antwortet, sonst **nicht erreichbar**. Ein
oranger Punkt bedeutet: Das Gerät antwortet, aber sein Ereignisstream ist nicht verbunden –
Erkennungen kommen nicht an.

## 4. Szenen

### Auslöser

- **Eine Hikvision-Kamera erkennt etwas** — Filter: die Kamera, das Ereignis (Bewegung,
  Linienüberschreitung, Eindringen, Bereichseintritt / -austritt, Sabotage, Gesicht, Szenenwechsel,
  zurückgelassenes oder entferntes Objekt, PIR, Videoverlust, Alarmeingang) und bei intelligenten
  Ereignissen das Ziel (Person oder Fahrzeug). Einmal pro Erkennung ausgelöst, nicht bei jeder
  Wiederholung der Kamera. Variablen: `event_type`, `target`, `device_name`, `channel`,
  `description`.
- **Eine Hikvision-Kamera geht offline** / **ist wieder online** — Variablen: `device_name` (und
  `reason` beim Offline-Gehen).

Die Erkennungsfunktionen (Bewegung, Eindringen…) funktionieren auch mit dem Standardauslöser
„Gerätezustand“.

### Aktionen

- **Hikvision-Schnappschuss aufnehmen** — nimmt das Bild sofort auf. Setze sie direkt vor die
  Gladys-Aktion „Kamerabild senden“, um genau den Moment der Erkennung zu erhalten. Ausgabe:
  `captured`.
- **Hikvision-Erkennung aktivieren oder deaktivieren** — schaltet eine Erkennung (Bewegung,
  Linienüberschreitung, Eindringen, Sabotage) einer Kamera ein oder aus. Ausgaben: `applied`,
  `enabled`.
- **Hikvision-PTZ-Kamera auf ein Preset fahren** — Preset-Nummer wie auf der Kamera gespeichert.
  Ausgabe: `moved`.

Beispiel: _Wenn die Kamera Garten ein Eindringen mit dem Ziel „Person“ erkennt und niemand zu Hause
ist → Schnappschuss aufnehmen → Kamerabild senden → Sirene (Alarmausgang) einschalten._

## 5. Dashboard-Widget

Füge das Widget **Hikvision** zu einem Dashboard hinzu: Kameras online, Erkennungen der letzten 24
Stunden, das Bild einer Kamera (die in den Widget-Einstellungen gewählte, sonst die, die zuletzt
etwas erkannt hat) und die letzte Erkennung jeder Kamera. Schaltflächen: **Schnappschuss**,
**Deaktivieren** und **Aktivieren** (alle Erkennungen aller Kameras, nach Bestätigung).

## Fehlerbehebung

| Problem                                 | Lösung                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Benutzername oder Passwort abgelehnt“  | Prüfe sie in der Weboberfläche des Geräts. Ist das Konto gesperrt, warte etwa 30 Minuten und speichere dann die Konfiguration erneut.                                              |
| „das Gerät beantwortet die ISAPI nicht“ | Aktiviere das Integrationsprotokoll (Schritt 1.2).                                                                                                                                 |
| „diesem Benutzer fehlen die Rechte“     | Gib ihm die Rolle Bediener oder das Recht, Parameter zu ändern.                                                                                                                    |
| Keine Erkennung kommt an                | Prüfe, dass die Erkennung auf der Kamera aktiviert ist **und** in ihrer Verknüpfung „Überwachungszentrale benachrichtigen“ angehakt ist. Schalte die detaillierten Protokolle ein. |
| „das Bild ist größer als die 150 KB“    | Senke die Auflösung des Substreams der Kamera (z. B. 640×360).                                                                                                                     |
| Eine Kamera am Rekorder ist offline     | Gladys zeigt sie als nicht erreichbar und löst „geht offline“ aus; sie kommt von selbst zurück.                                                                                    |
| HTTPS abgelehnt                         | Verwende `http://` oder deaktiviere „HTTPS-Zertifikat prüfen“; prüfe den Port.                                                                                                     |

## Datenschutz und Sicherheit

Alles bleibt zwischen Gladys und deinen Geräten, in deinem Netzwerk. Das Passwort liegt in einem
geheimen Feld von Gladys und wird nie protokolliert. Die Integration speichert in ihrem Ordner
`/data` nur, was sie von den Geräten erfahren hat (Modell, Seriennummer, Kanäle), damit ein beim
Start ausgeschaltetes Gerät trotzdem als offline erscheint.
