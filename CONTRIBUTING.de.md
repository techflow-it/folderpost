# Mitwirken an Folderpost

Danke für das Interesse! Fehlermeldungen, Ideen und Pull-Requests sind willkommen.

[English version](CONTRIBUTING.md)

## Fehler und Ideen melden

Bitte die [Vorlagen für Issues](https://github.com/TechFlow-IT/folderpost/issues/new/choose) verwenden.
Bitte **keine** echten Dokumente, Konfigurationsdateien mit Zugangsdaten oder internen
Rechnernamen anhängen — das Problem auf ein synthetisches Beispiel reduzieren.
Sicherheitslücken bitte über die [Sicherheitsrichtlinie](SECURITY.de.md) melden, nicht öffentlich.

## Entwicklungsumgebung

```sh
git clone https://github.com/TechFlow-IT/folderpost.git
cd folderpost
node server.js            # http://localhost:3000
npm test                  # node:test, keine Abhängigkeiten
```

Der i18n-Abnahmetest braucht Python und Playwright:

```sh
pip3 install playwright && python3 -m playwright install chromium
python3 tools/i18n-scan.py            # kein Deutsch in der englischen Oberfläche
python3 tools/i18n-scan.py --lang de  # kein Englisch in der deutschen Oberfläche
python3 tools/xss-scan.py             # Benutzerdaten werden nie als HTML ausgeführt
```

Bildschirmfotos und Test-PDFs werden erzeugt, nie echte verwendet:

```sh
python3 tools/screenshots.py          # docs/img/ mit Demodaten (tools/demo-data.py)
python3 tools/make-fixtures.py        # tests/fixtures/ (braucht Pillow und qrencode)
```

## Codestil

- Node.js ≥ 18, CommonJS, **keine Laufzeit-Abhängigkeiten** — das soll so bleiben.
- Einrückung mit zwei Leerzeichen, einfache Anführungszeichen, Semikolons (siehe `.editorconfig`).
- Englisch ist die Quellsprache für Code, Kommentare und Texte.
  Jeder sichtbare Text läuft über `t()` (Browser), `T()` (API-Antwort) oder
  `L()` (Protokoll, E-Mail, Webhook) und braucht einen deutschen Eintrag in `public/locales/de.json`.
- Jede Quelldatei beginnt mit dem SPDX-Kopf:
  ```js
  // SPDX-License-Identifier: GPL-3.0-or-later
  // Copyright (C) 2026 TechFlow IT
  ```
- Testdaten müssen synthetisch sein. Niemals echte Scans, Kundendaten oder interne Pfade einchecken.

## Pull-Requests

- Ein Thema je Pull-Request; beschreiben, was sich ändert und warum.
- `npm test` und beide i18n-Scans müssen grün sein; die CI prüft das unter Linux, macOS und Windows.
- Einen Eintrag unter „Unreleased“ in `CHANGELOG.md` und `CHANGELOG.de.md` ergänzen.

## Developer Certificate of Origin

Mit einem Beitrag bestätigst du das [Developer Certificate of Origin 1.1](https://developercertificate.org/):
Du hast die Änderung selbst geschrieben oder darfst sie aus anderen Gründen unter der
Lizenz des Projekts einreichen. Jeden Commit bitte abzeichnen:

```sh
git commit -s -m "Änderung beschreiben"
```

Das ergänzt eine Zeile `Signed-off-by: Dein Name <du@example.org>`. Beiträge stehen
unter der GNU GPL v3.0 oder neuer.
