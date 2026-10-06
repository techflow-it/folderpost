# Technische Beschreibung

[English version](../en/technical-description.md) · [README](../../README.de.md)

Dieses Dokument richtet sich an IT-Verantwortliche, die Folderpost prüfen, einrichten oder betreiben.

## 1. Was Folderpost tut

Folderpost überwacht Ordner, nimmt dort abgelegte Dateien auf und übergibt sie an ein Ziel —
eine HTTP-Schnittstelle, einen anderen Ordner oder ein Postfach. Optional wertet es QR-Codes
auf eingescannten Belegen aus und teilt Stapelscans an diesen Codes in Einzeldokumente.

## 2. Voraussetzungen

| System | Stand | Anmerkung |
|---|---|---|
| macOS 13 oder neuer | unterstützt | Entwicklungsplattform; `start.sh`, launchd |
| Linux (Debian, Ubuntu, RHEL …) | unterstützt | `start.sh`, systemd |
| Windows 10/11, Windows Server 2016+ | unterstützt | `start.bat`, geplante Aufgabe oder Dienst |

- **Node.js 18 oder neuer** (empfohlen 20 oder 22). Unter Windows kann ein portables Node.js
  in `runtime/node-win-x64/` liegen (siehe `runtime/README.txt`).
- **curl** für HTTP-Ziele. Bestandteil von macOS, Windows 10 (1803) und neuer sowie fast aller
  Linux-Distributionen.
- **Sonst nichts**: keine Datenbank, keine npm-Pakete, keine Installationsroutine, keine
  Registrierungseinträge. Poppler (`pdftoppm`, `pdftocairo`) und ZBar (`zbarimg`) werden als
  optionale Rückfallwege genutzt, falls sie vorhanden sind, sind aber nicht nötig.

| Hardware | Empfehlung |
|---|---|
| Arbeitsspeicher | 512 MB frei; mit PDF-Auswertung 1 GB |
| Festplatte | 50 MB für die Anwendung, dazu Platz für Protokolle |
| Prozessor | beliebig; die QR-Auswertung eines DIN-A4-Scans dauert etwa 0,5–2 Sekunden |

Dateien werden nacheinander abgearbeitet; im Leerlauf belastet Folderpost das System praktisch nicht.

## 3. Aufbau

```
folderpost/
├── server.js        Kern: Ablaufsteuerung, Webserver, REST-Schnittstelle
├── processing.js    PDF-Auswertung und Nachrichtenerzeugung
├── pdf-split.js     Aufteilen von Stapelscans
├── qr.js            QR-Decoder (Suchmuster, Entzerrung, Reed-Solomon)
├── jpeg.js          Baseline-JPEG-Decoder
├── ccitt.js         Decoder für CCITT Gruppe 4 (Schwarzweiß-Scans)
├── delivery.js      Zustellung in Ordner und per E-Mail (SMTP)
├── update.js        Einspielen von Aktualisierungspaketen
├── i18n.js          Übersetzungen auf dem Server
├── public/          Weboberfläche (HTML, CSS, JavaScript, Sprachdateien)
├── runtime/         optionales portables Node.js (Windows)
├── data/            Protokolle und Sicherungen — entsteht beim ersten Start
└── config.json      Konfiguration — entsteht beim ersten Start
```

Folderpost ist ein einzelner Node.js-Vorgang. Er startet einen Webserver und arbeitet die Jobs in einer Zeitschleife ab.

## 4. Netzwerk

### Eingehend

| Port | Zweck | Voreinstellung |
|---|---|---|
| 3000 | Weboberfläche und REST-Schnittstelle | `port` in `config.json` oder Umgebungsvariable `PORT` |

Folderpost hört auf allen Netzwerkkarten (`0.0.0.0`) und ist damit aus dem lokalen Netz
erreichbar. Soll es nur lokal erreichbar sein — etwa hinter einem Reverse-Proxy —, in
`config.json` `"host": "127.0.0.1"` setzen oder mit `HOST=127.0.0.1` starten.

### Ausgehend

Verbindungen entstehen ausschließlich dort, wo sie eingerichtet wurden:

- zu den **Ziel-URLs** der Jobs (Port je nach Angabe, üblich 443 oder 80),
- zum **SMTP-Server** von E-Mail-Zielen und Benachrichtigungen (üblich 587),
- zum **Benachrichtigungs-Webhook**, falls eingerichtet,
- zur **Prüf-Adresse für Aktualisierungen**, falls hinterlegt.

Darüber hinaus keine. Die Oberfläche lädt nichts von außen nach; Schriften und Skripte gehören zur Anwendung.

### Dateizugriff

Auf Quell- und Zielordner wird mit den Rechten des Kontos zugegriffen, unter dem Folderpost
läuft. Bei Netzwerkfreigaben braucht dieses Konto Lese- **und** Schreibrechte, weil verarbeitete
Dateien in Unterordner verschoben werden. Siehe [Netzwerkfreigaben](netzwerkfreigaben.md).

## 5. Daten und Ablage

| Pfad | Inhalt |
|---|---|
| `config.json` | Jobs, Vorlagen, Benutzer und Einstellungen; wird bei jeder Änderung neu geschrieben |
| `data/config-backups/` | die letzten 10 Stände von `config.json` |
| `data/logs.jsonl` | Übertragungsprotokoll, eine JSON-Zeile je Übertragung; Einträge älter als die Aufbewahrungsfrist (Standard 90 Tage) werden entfernt |
| `data/aenderungen.jsonl` | Änderungsprotokoll: wer wann welchen Job angelegt, geändert oder gelöscht hat |
| `data/update-sicherungen/` | Sicherungen vor dem Einspielen einer Aktualisierung (die letzten fünf) |
| `<Quelle>/_sent`, `_error`, `_quarantine`, `_qr-check` | Archiv, Fehler, Quarantäne und QR-Prüfbilder innerhalb der Quellordner (Namen einstellbar) |

`config.json` enthält Zugangsdaten für Schnittstellen und Mailserver **im Klartext** (curl und
SMTP brauchen sie so). Die Datei nur für das Dienstkonto und Administratoren lesbar machen.
Die Passwörter der Folderpost-Benutzer stehen dort als PBKDF2-Ableitung.

Grobe Schätzung für das Protokoll: etwa 400 Byte je Übertragung, also rund 12 MB bei 30.000 Übertragungen.

Für eine vollständige Sicherung genügen `config.json` und der Ordner `data/`. Die Konfiguration
lässt sich zusätzlich in der Oberfläche als Datei exportieren (**Export / Import**).

## 6. Ablauf einer Übertragung

1. **Scan** — im eingestellten Intervall wird der Quellordner gelesen und gegen den Dateifilter geprüft.
2. **Ruhezeit** — Dateien, die jünger als das Mindestalter sind, bleiben liegen; so werden nie
   halb geschriebene Dateien übertragen.
3. **Verarbeitung** (optional) — das Seitenbild wird aus dem PDF gelesen, der QR-Code dekodiert
   und die Nachricht nach der Vorlage gebaut. Mit eingeschalteter Aufteilung entstehen mehrere Teildokumente.
4. **Übertragung** — per curl, durch Kopieren in den Zielordner oder per SMTP.
5. **Nachbereitung** — bei Erfolg wandert die Datei in den Archiv-Unterordner, bei Fehler je nach
   Einstellung in den Fehler-Unterordner, oder sie bleibt für einen erneuten Versuch liegen.
6. **Protokoll** — jeder Vorgang wird mit Ergebnis, Antwort der Gegenstelle und erkanntem QR-Wert festgehalten.

**Wiederholungen:** Nach einem Fehlschlag wartet Folderpost, bevor es erneut versucht. Die
Wartezeit beginnt bei der eingestellten Grundzeit und verdoppelt sich mit jedem Versuch,
gedeckelt auf eine Stunde. Nach der eingestellten Anzahl Versuche wandert die Datei in den
Quarantäne-Unterordner, und es kann eine [Benachrichtigung](benachrichtigungen.md) erfolgen.
Der Fehlerzähler ist reiner Laufzeitzustand und beginnt nach einem Neustart wieder bei null.

## 7. PDF- und QR-Auswertung

| Kompression der Seitenbilder | Unterstützt |
|---|---|
| JPEG (DCTDecode) | ja |
| CCITT Gruppe 4 (Schwarzweiß-Scans) | ja |
| Flate / unkomprimiert | ja |
| CCITT Gruppe 3 | nein |
| JBIG2 | nein |
| JPEG 2000 | nein |

Bei nicht unterstützter Kompression nennt die Fehlermeldung das Verfahren und schlägt eine Umstellung am Scanner vor.

Der QR-Decoder ist Teil von Folderpost — kein maschinelles Lernen, keine Fremdsoftware, sondern
eine Umsetzung von ISO/IEC 18004: Schwellenwert nach Otsu, Suche der Suchmuster über
Verhältniszahlen, perspektivische Entzerrung, Bitentnahme im Zickzack und Reed-Solomon-Fehlerkorrektur.
Er verträgt Rauschen, ungleichmäßige Schwärzung, leichte Drehung und Verzerrung, wie sie beim Scannen entstehen.

**Aufteilen von Stapelscans:** Jede Seite mit QR-Code beginnt ein neues Dokument; Seiten ohne
Code gehören zum vorherigen. Die Teildokumente werden als eigenständige PDFs neu aufgebaut, die
**Seitenbilder byteweise unverändert** übernommen — es wird nichts neu komprimiert. Metadaten des
Originals wie Erstellungsdatum oder eine eingebettete Textebene gehen verloren. Schlägt das
Aufteilen fehl, wird die Datei unverändert als Ganzes übertragen.

## 8. Benutzer und Rollen

Solange kein Benutzer angelegt ist, arbeitet Folderpost ohne Anmeldung. Sobald der erste Benutzer existiert, wird eine Anmeldung verlangt.

| Rolle | Darf |
|---|---|
| Verwaltung | alles: Jobs löschen, Benutzer verwalten, Einstellungen, Aktualisierungen |
| Benutzer | Jobs anlegen, ändern, pausieren, ausführen, archivieren |
| Betrachter | nur ansehen |

Die Rechte werden auf dem Server geprüft.

- **Sitzungen:** Nach der Anmeldung liegt ein zufälliges Merkmal in einem Cookie (`HttpOnly`,
  `SameSite=Lax`). Sitzungen enden nach 12 Stunden und liegen im Arbeitsspeicher — nach einem
  Neustart melden sich alle erneut an.
- **Passwörter:** PBKDF2 mit 200.000 Runden und zufälligem Salz. Nach fünf Fehlversuchen wird
  der Zugang gesperrt; die Wartezeit wächst mit jedem weiteren Versuch bis auf 15 Minuten.
- Hinterlegte Passwörter für Schnittstellen und Mailserver werden nie an den Browser
  ausgeliefert — die Oberfläche zeigt nur, ob eines gesetzt ist.

## 9. Verschlüsselung

Die Weboberfläche selbst spricht unverschlüsseltes HTTP. Für verschlüsselten Zugriff einen
Reverse-Proxy vorschalten — etwa Caddy, nginx oder IIS mit Application Request Routing —, der
HTTPS annimmt und an `http://127.0.0.1:3000` weiterleitet. Folderpost dann auf `127.0.0.1`
beschränken, damit es nicht am Proxy vorbei erreichbar ist.

Ausgehende Verbindungen zu HTTPS-Zielen verschlüsselt curl und prüft dabei wie üblich das
Zertifikat (außer mit `-k`). E-Mails nutzen STARTTLS oder direktes TLS. **Hinweis:** Bei
SMTP-Verbindungen und Benachrichtigungs-Webhooks wird das TLS-Zertifikat derzeit nicht geprüft,
damit interne Server mit selbst signierten Zertifikaten funktionieren.

## 10. Betrieb

| Startart | Geeignet für | Einstellung „Verhalten nach dem Einspielen“ |
|---|---|---|
| `start.sh` / `start.bat` im Terminal | Einzelplatz, Test | Selbst neu starten |
| launchd (macOS), systemd (Linux) | Dauerbetrieb | Nur beenden |
| Geplante Aufgabe oder Dienst (Windows) | Dauerbetrieb | Nur beenden |

Folderpost erkennt an der Umgebung, welche Betriebsart vermutlich vorliegt, und weist darauf
hin, wenn die Einstellung nicht passt. Siehe [Betrieb als Dienst](betrieb-als-dienst.md).

**Aktualisierung:** Ein neues Paket wird unter **Einstellungen → System & Wartung** als ZIP
hochgeladen. Vorher entsteht eine Sicherung des jetzigen Standes. Konfiguration, Protokolle,
Benutzer und der Ordner `runtime/` bleiben erhalten. Archive ohne `server.js` oder mit Pfaden
außerhalb des Zielordners werden abgewiesen; schlägt das Einspielen fehl, wird der alte Stand
wiederhergestellt. Bei einem Git-Klon genügt alternativ `git pull` und ein Neustart.

**Selbstdiagnose:** Beim Start und danach regelmäßig prüft Folderpost, ob Quellordner erreichbar
sind, ob Konfigurationen schlüssig sind und ob ein Job wiederholt keinen QR-Code findet.
Auffälligkeiten erscheinen als Hinweis in der Oberfläche.

## 11. Sprache

Die Oberfläche gibt es auf **Deutsch und Englisch**; jeder Browser wählt über die Schaltfläche
`DE`/`EN` in der Kopfzeile. Protokolleinträge, Benachrichtigungs-E-Mails und Webhooks werden in
der Sprache geschrieben, die unter **Einstellungen → Allgemein** gewählt ist. Einträge behalten
die Sprache, in der sie entstanden sind. Jobnamen, Pfade, Dateinamen und Antworten der
Gegenstellen werden nicht übersetzt.

## 12. Grenzen

- **Ein Vorgang, eine Konfiguration.** Für getrennte Umgebungen mehrere Instanzen auf
  verschiedenen Ports betreiben. Nie zwei Instanzen aus demselben Ordner starten — das kann zu
  doppelten Übertragungen führen.
- **Überlappende Filter:** Zwei Jobs auf demselben Ordner mit überlappendem Filter nehmen sich
  gegenseitig Dateien weg. Folderpost warnt davor.
- **Große Dateien** werden beim JSON-Format vollständig in den Speicher geladen. Ab etwa 200 MB
  besser Multipart oder ein Ordnerziel verwenden.
- **Kein OCR.** Ausgewertet werden QR-Codes, kein Text.
- **„Gesendete Daten prüfen“** kann die Teildokumente aufgeteilter Stapel nicht erneut anzeigen,
  da sie nicht gespeichert werden.

## 13. Fehlersuche

| Beobachtung | Mögliche Ursache |
|---|---|
| „Ordner nicht erreichbar“ | Freigabe nicht verbunden/eingehängt oder Konto ohne Rechte |
| Dateien bleiben liegen | Ruhezeit noch nicht abgelaufen oder Zeitfenster greift |
| „Kein QR-Code gefunden“ | nicht unterstützte Kompression oder Code zu klein — das Prüfbild im Protokoll hilft |
| Gegenstelle meldet Fehler | Metadaten über „gesendete Daten prüfen“ kontrollieren; der dort gezeigte `curl`-Aufruf lässt sich von Hand ausführen |
| Oberfläche nicht erreichbar | Vorgang läuft nicht, Port belegt oder durch die Firewall gesperrt |
