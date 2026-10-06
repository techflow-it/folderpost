# Folderpost

**Selbst betriebene Datei-Übertragung aus Ordnern an Schnittstellen — mit Aufteilung von Scans an QR-Codes.**

Folderpost überwacht Ordner — lokal oder auf einer Netzwerkfreigabe — und stellt
jede neue Datei einem Ziel zu: einer HTTP-Schnittstelle (über `curl`), einem
anderen Ordner oder einem E-Mail-Postfach. Eingescannte PDFs lassen sich dabei
auswerten: Folderpost liest QR-Codes, teilt Stapelscans in Einzeldokumente und
sendet das Ergebnis als JSON oder Multipart-Formular. Eingerichtet und überwacht
wird alles in einer Weboberfläche.

Typischer Einsatz: Ersatz für ein gewachsenes Batch-Skript, das Dateien an eine
Schnittstelle schiebt, oder für den Handgriff „scannen → umbenennen → hochladen“.

[English version](README.md)

![Übersicht (dunkel)](docs/img/de-dark-overview.png)

- Reines Node.js — **keine npm-Abhängigkeiten, keine Datenbank, kein Build-Schritt**
- Einziges externes Programm ist **`curl`** (vorinstalliert unter macOS, Windows 10+ und den meisten Linux-Distributionen)
- Eigene JPEG-, CCITT-G4- und QR-Decoder — weder Poppler noch ZBar noch OCR nötig
- Oberfläche auf Deutsch und Englisch

## Schnellstart

Voraussetzungen: **Node.js 18 oder neuer** und **curl**.

### macOS

```sh
brew install node          # curl gehört bereits zu macOS
git clone https://github.com/TechFlow-IT/folderpost.git
cd folderpost
./start.sh
```

### Linux

```sh
sudo apt install nodejs curl   # bzw. über die Paketverwaltung der Distribution
git clone https://github.com/TechFlow-IT/folderpost.git
cd folderpost
./start.sh
```

### Windows

Node.js LTS von <https://nodejs.org> installieren (oder ein portables Node.js nach
`runtime\node-win-x64\` legen, siehe [runtime/README.txt](runtime/README.txt)),
das Repository herunterladen oder klonen und `start.bat` doppelklicken.

Danach **<http://localhost:3000>** öffnen. `config.json` und der Ordner `data/`
entstehen beim ersten Start. Adresse ändern: `port` / `host` in `config.json` setzen
oder mit `PORT=8080 HOST=127.0.0.1 node server.js` starten.

> Solange kein Benutzer angelegt ist, kann jeder, der den Port erreicht, die
> Oberfläche bedienen. Vor dem Einsatz im Netzwerk unter **Einstellungen →
> Benutzer & Zugriff** einen Benutzer mit der Rolle „Verwaltung“ anlegen.

## Funktionen

**Übertragung**
- Jobs mit Quell-Ordner, Dateifilter (`*.xml`, `scan_*.pdf` …), Scan-Intervall und Ziel
- Ziele: HTTP-Schnittstelle über `curl` (Methode, Header, Basic-Auth, zusätzliche
  curl-Parameter, Rohdaten oder Multipart), Ordner (atomares Schreiben über Zwischennamen),
  E-Mail-Anhang (SMTP, STARTTLS/TLS)
- Zusätzliche Ziele je Job — ein Lauf gilt nur als erfolgreich, wenn alle Ziele erfolgreich waren
- Ruhezeit (Mindestalter der Datei), damit nie halb geschriebene Dateien gesendet werden
- Verschieben in die Unterordner `_sent` / `_error` oder liegen lassen; Archiv nach N Tagen aufräumen
- Wiederholungen mit wachsender Wartezeit und Quarantäne-Ordner nach N Versuchen
- Zeitfenster (Wochentage, Uhrzeiten), Testmodus (nur protokollieren), Duplikat-Erkennung (SHA-256)

**Eingescannte PDFs**
- QR-Code einer Seite auslesen und eine JSON-Nachricht mit Wert und eingebettetem PDF senden
- Oder `multipart/form-data` mit PDF plus Metadatenfeld aus einer Vorlage
  (`{qrValue}`, `{filename}`, `{unixtime}`, benannte Gruppen aus einem Dateinamen-Ausdruck …)
- Stapelscans an Seiten mit QR-Code aufteilen; die Seitenbilder werden byteweise übernommen
- Unterstützte Seitenbilder: JPEG, CCITT Gruppe 4, Flate/unkomprimiert
- „Gesendete Daten prüfen“ zeigt genau, was gesendet wurde bzw. würde — samt `curl`-Aufruf zum Nachstellen

**Betrieb**
- Übersicht mit Zustand, Verlaufsstreifen, Sparklines und Health je Job; Statistik je Tag, Job, Kategorie und Schnittstelle
- Übertragungsprotokoll mit Suche, Filtern, CSV-Export, „erneut senden“ und Download fehlgeschlagener Dateien
- Benutzer mit Rollen (Verwaltung, Benutzer, Betrachter), PBKDF2-Passwörter, Anmeldesperre
- Benachrichtigung per E-Mail und/oder Webhook, wenn eine Datei in die Quarantäne wandert
- Selbstdiagnose und Warnungen vor riskanten Einstellungen (überlappende Filter, keine Ruhezeit …)
- Änderungsprotokoll, Job-Vorlagen, Kategorien, Sammelaktionen, Schnellzugriff (Strg+K)
- Konfigurations-Sicherungen, Export/Import, Aktualisierung durch Hochladen eines ZIP-Pakets
- Heller und dunkler Modus, eigener Name, Logo und Akzentfarbe

Weitere Bildschirmfotos: [docs/de/screenshots.md](docs/de/screenshots.md)

| Job-Formular | Statistik |
|---|---|
| ![Job-Formular](docs/img/de-light-job-form.png) | ![Statistik](docs/img/de-light-statistics.png) |

## Dokumentation

- [Technische Beschreibung](docs/de/technische-beschreibung.md) — Aufbau, Daten, Netzwerk, Sicherheit, Grenzen
- [Betrieb als Dienst](docs/de/betrieb-als-dienst.md) — systemd, launchd (macOS), Windows-Aufgabe oder -Dienst
- [Netzwerkfreigaben](docs/de/netzwerkfreigaben.md) — UNC-Pfade, SMB unter macOS und Linux
- [Benachrichtigungen](docs/de/benachrichtigungen.md) — E-Mail und Webhook
- [Änderungen](CHANGELOG.de.md) · [Mitwirken](CONTRIBUTING.de.md) · [Sicherheit](SECURITY.de.md)

## Grenzen

- Dateien werden per Abfrage (Polling) erkannt, nicht über Dateisystem-Ereignisse — eine Datei wird beim nächsten Scan aufgenommen.
- Ein Vorgang, eine Konfiguration. Für getrennte Umgebungen mehrere Instanzen auf verschiedenen Ports betreiben
  und nie zwei Instanzen aus demselben Ordner starten.
- Zwei Jobs mit überlappendem Filter im selben Ordner nehmen sich gegenseitig Dateien weg (Folderpost warnt davor).
- Kein OCR: ausgewertet werden QR-Codes, kein Text. Seitenbilder in JBIG2, JPEG 2000 und CCITT Gruppe 3 werden nicht unterstützt.
- Das JSON-Format lädt die ganze Datei in den Speicher; ab etwa 200 MB besser Multipart oder ein Ordnerziel verwenden.
- Die Weboberfläche selbst spricht unverschlüsseltes HTTP; für HTTPS einen Reverse-Proxy vorschalten (siehe technische Beschreibung).
- Zugangsdaten für Schnittstellen und Mailserver stehen im Klartext in `config.json` — die Datei entsprechend schützen.

## Entwicklung

```sh
npm test                           # node:test, keine Abhängigkeiten
python3 tools/i18n-scan.py         # englische Oberfläche ohne Deutsch (braucht Playwright)
python3 tools/i18n-scan.py --lang de
python3 tools/xss-scan.py          # Benutzerdaten werden nie als HTML ausgeführt
```

Siehe [CONTRIBUTING.de.md](CONTRIBUTING.de.md).

## Support

Fragen, Fehlermeldungen und Ideen: [GitHub Issues](https://github.com/TechFlow-IT/folderpost/issues).
Sicherheitslücken: siehe [Sicherheitsrichtlinie](SECURITY.de.md).

## Lizenz

Copyright (C) 2026 TechFlow IT

Folderpost steht unter der [GNU General Public License v3.0 oder neuer](LICENSE).
Für die Dokumentation gelten dieselben Bedingungen.
