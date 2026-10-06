# Folderpost

**Self-hosted folder-to-API file transfer with QR-based document splitting.**

Folderpost watches folders — local or on a network share — and delivers every new
file to a target: an HTTP API (via `curl`), another folder or an e-mail inbox.
Scanned PDFs can be evaluated on the way: Folderpost reads QR codes, splits batch
scans into individual documents and sends the result as JSON or multipart form data.
Everything is configured and monitored in a web interface.

Typical use: replacing a grown batch script that pushes files to an interface, or
a manual "scan → rename → upload" step.

[Deutsche Fassung](README.de.md)

![Overview (dark)](docs/img/en-dark-overview.png)

- Plain Node.js — **no npm dependencies, no database, no build step**
- The only external program is **`curl`** (pre-installed on macOS, Windows 10+ and most Linux distributions)
- Built-in JPEG, CCITT G4 and QR decoders — no Poppler, ZBar or OCR needed
- English and German interface

## Quick start

Requirements: **Node.js 18 or newer** and **curl**.

### macOS

```sh
brew install node          # curl is already part of macOS
git clone https://github.com/TechFlow-IT/folderpost.git
cd folderpost
./start.sh
```

### Linux

```sh
sudo apt install nodejs curl   # or the package manager of your distribution
git clone https://github.com/TechFlow-IT/folderpost.git
cd folderpost
./start.sh
```

### Windows

Install Node.js LTS from <https://nodejs.org> (or put a portable Node.js into
`runtime\node-win-x64\`, see [runtime/README.txt](runtime/README.txt)), download or
clone the repository and double-click `start.bat`.

Then open **<http://localhost:3000>**. `config.json` and the `data/` folder are
created on first start. To change the address, set `port` / `host` in `config.json`
or start with `PORT=8080 HOST=127.0.0.1 node server.js`.

> Without any user accounts, the web interface is open to everyone who can reach
> the port. Create an administrator under **Settings → Users & access** before
> using Folderpost in a network.

## Features

**Transfer**
- Jobs with source folder, file filter (`*.xml`, `scan_*.pdf` …), scan interval and target
- Targets: HTTP API via `curl` (method, headers, Basic auth, extra curl parameters,
  raw or multipart upload), folder (atomic write via temporary name), e-mail attachment (SMTP, STARTTLS/TLS)
- Additional targets per job — a run only counts as successful if all targets succeed
- Settle time (minimum file age) so that half-written files are never sent
- Move to `_sent` / `_error` subfolders or leave files in place; archive clean-up after N days
- Retries with exponential back-off and a quarantine folder after N attempts
- Time windows (weekdays, hours), test mode (log only), duplicate detection (SHA-256)

**Scanned PDFs**
- Read the QR code of a page and send a JSON message with the value and the embedded PDF
- Or send `multipart/form-data` with the PDF plus a metadata field built from a template
  (`{qrValue}`, `{filename}`, `{unixtime}`, named groups from a file-name regex …)
- Split batch scans at pages carrying a QR code; page images are copied byte-for-byte
- Supported page images: JPEG, CCITT Group 4, Flate/uncompressed
- "Inspect sent data" shows exactly what was (or would be) sent, including a `curl` command to reproduce it

**Operation**
- Overview with status, history strip, sparklines and health per job; statistics per day, job, category and API endpoint
- Transfer log with search, filters, CSV export, "send again" and download of failed files
- Users with roles (administrator, user, viewer), PBKDF2 password hashes, sign-in lockout
- Notifications by e-mail and/or webhook when a file is moved to quarantine
- Self-check and warnings for risky configurations (overlapping filters, no settle time …)
- Change log, job templates, categories, bulk actions, command palette (Ctrl+K)
- Configuration backups, export/import, update by uploading a ZIP package
- Light and dark theme, custom name, logo and accent colour

More screenshots: [docs/en/screenshots.md](docs/en/screenshots.md)

| Job form | Statistics |
|---|---|
| ![Job form](docs/img/en-light-job-form.png) | ![Statistics](docs/img/en-light-statistics.png) |

## Documentation

- [Technical description](docs/en/technical-description.md) — architecture, data, network, security, limits
- [Running as a service](docs/en/running-as-a-service.md) — systemd, launchd (macOS), Windows task or service
- [Network shares](docs/en/network-shares.md) — UNC paths, SMB on macOS and Linux
- [Notifications](docs/en/notifications.md) — e-mail and webhook
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

## Limits

- Files are detected by polling, not by file-system events — a file is picked up at the next scan.
- One process, one configuration. Run several instances on different ports for separate environments,
  and never start two instances from the same folder.
- Two jobs with overlapping filters on the same folder take files away from each other (Folderpost warns about this).
- No OCR: only QR codes are evaluated, not text. JBIG2, JPEG 2000 and CCITT Group 3 page images are not supported.
- The JSON format loads the whole file into memory; for files above roughly 200 MB use multipart or a folder target.
- The web interface itself speaks plain HTTP; use a reverse proxy for HTTPS (see the technical description).
- Credentials for target APIs and mail servers are stored in plain text in `config.json` — protect that file.

## Development

```sh
npm test                           # node:test, no dependencies
python3 tools/i18n-scan.py         # English UI must contain no German (needs Playwright)
python3 tools/i18n-scan.py --lang de
python3 tools/xss-scan.py          # user data is never executed as HTML
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

Questions, bug reports and ideas: [GitHub Issues](https://github.com/TechFlow-IT/folderpost/issues).
Security issues: see the [security policy](SECURITY.md).

## License

Copyright (C) 2026 TechFlow IT

Folderpost is licensed under the [GNU General Public License v3.0 or later](LICENSE).
The documentation is licensed under the same terms.
