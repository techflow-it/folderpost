# Technical description

[Deutsche Fassung](../de/technische-beschreibung.md) · [README](../../README.md)

This document is meant for administrators who evaluate, set up or run Folderpost.

## 1. What Folderpost does

Folderpost watches folders, picks up files placed there and hands them over to a
target — an HTTP API, another folder or a mailbox. Optionally it evaluates QR codes
on scanned documents and splits batch scans into individual documents at those codes.

## 2. Requirements

| System | Status | Notes |
|---|---|---|
| macOS 13 or newer | supported | development platform; `start.sh`, launchd |
| Linux (Debian, Ubuntu, RHEL …) | supported | `start.sh`, systemd |
| Windows 10/11, Windows Server 2016+ | supported | `start.bat`, scheduled task or service |

- **Node.js 18 or newer** (20 or 22 recommended). On Windows a portable Node.js can be
  placed in `runtime/node-win-x64/` (see `runtime/README.txt`).
- **curl** for HTTP targets. It is part of macOS, Windows 10 (1803) and newer, and
  nearly every Linux distribution.
- **Nothing else**: no database, no npm packages, no installer, no registry entries.
  Poppler (`pdftoppm`, `pdftocairo`) and ZBar (`zbarimg`) are used as optional
  fallbacks if they happen to be installed, but are not needed.

| Hardware | Recommendation |
|---|---|
| Memory | 512 MB free; 1 GB with PDF evaluation |
| Disk | 50 MB for the application plus space for logs |
| CPU | any; evaluating the QR code of an A4 scan takes about 0.5–2 seconds |

Files are processed one after another; when idle, Folderpost puts practically no load on the system.

## 3. Structure

```
folderpost/
├── server.js        core: scheduling, web server, REST API
├── processing.js    PDF evaluation and message building
├── pdf-split.js     splitting of batch scans
├── qr.js            QR decoder (finder patterns, sampling, Reed-Solomon)
├── jpeg.js          baseline JPEG decoder
├── ccitt.js         CCITT Group 4 decoder (black-and-white scans)
├── delivery.js      delivery to folders and by e-mail (SMTP)
├── update.js        installing update packages
├── i18n.js          server-side translations
├── public/          web interface (HTML, CSS, JavaScript, locales)
├── runtime/         optional portable Node.js (Windows)
├── data/            logs and backups — created on first start
└── config.json      configuration — created on first start
```

Folderpost is a single Node.js process. It starts a web server and processes the jobs in a timer loop.

## 4. Network

### Incoming

| Port | Purpose | Default |
|---|---|---|
| 3000 | web interface and REST API | `port` in `config.json` or the `PORT` environment variable |

Folderpost listens on all interfaces (`0.0.0.0`) and is therefore reachable from the
local network. To restrict it to the local machine — for example behind a reverse
proxy — set `"host": "127.0.0.1"` in `config.json` or start it with `HOST=127.0.0.1`.

### Outgoing

Connections are only made where they have been configured:

- to the **target URLs** of the jobs (port as specified, usually 443 or 80),
- to the **SMTP server** of e-mail targets and notifications (usually 587),
- to the **notification webhook**, if one is configured,
- to the **update check address**, if one is configured.

Nothing else. The web interface loads no external resources; fonts and scripts are part
of the application.

### File access

Source and target folders are accessed with the rights of the account Folderpost runs
under. On network shares this account needs read **and** write access, because
processed files are moved into subfolders. See [network shares](network-shares.md).

## 5. Data and storage

| Path | Content |
|---|---|
| `config.json` | jobs, templates, users and settings; rewritten on every change |
| `data/config-backups/` | the last 10 states of `config.json` |
| `data/logs.jsonl` | transfer log, one JSON line per transfer; entries older than the retention period (default 90 days) are removed |
| `data/aenderungen.jsonl` | change log: who created, changed or deleted which job and when |
| `data/update-sicherungen/` | backups made before installing an update (the last five) |
| `<source>/_sent`, `_error`, `_quarantine`, `_qr-check` | archive, error, quarantine and QR check images inside the source folders (names configurable) |

`config.json` contains credentials for target APIs and mail servers **in plain text**
(curl and SMTP need them that way). Make it readable only for the service account and
administrators. User passwords of Folderpost itself are stored as PBKDF2 hashes.

Rough estimate for the log: about 400 bytes per transfer, i.e. about 12 MB for 30,000 transfers.

For a full backup, save `config.json` and the `data/` folder. The configuration can also
be exported as a file in the web interface (**Export / import**).

## 6. Processing a file

1. **Scan** — at the configured interval the source folder is read and matched against the file filter.
2. **Settle time** — files younger than the minimum file age stay where they are, so that
   half-written files are never transferred.
3. **Processing** (optional) — the page image is read from the PDF, the QR code decoded and
   the message built from the template. With splitting enabled, several parts are created.
4. **Transfer** — via curl, by copying into the target folder or by SMTP.
5. **Follow-up** — on success the file is moved to the archive subfolder; on error, depending on
   the setting, into the error subfolder, or it stays for another attempt.
6. **Log** — every transfer is recorded with its result, the response of the receiving side and the detected QR value.

**Retries:** after a failure Folderpost waits before trying again. The waiting time starts at the
configured base value and doubles with every attempt, capped at one hour. After the configured
number of attempts the file is moved to the quarantine subfolder and a
[notification](notifications.md) can be sent. The failure counter is runtime state only and is
reset when Folderpost restarts.

## 7. PDF and QR evaluation

| Page image compression | Supported |
|---|---|
| JPEG (DCTDecode) | yes |
| CCITT Group 4 (black-and-white scans) | yes |
| Flate / uncompressed | yes |
| CCITT Group 3 | no |
| JBIG2 | no |
| JPEG 2000 | no |

For unsupported compression the error message names the method and suggests changing the scanner setting.

The QR decoder is part of Folderpost — no machine learning and no third-party software, but an
implementation of ISO/IEC 18004: Otsu thresholding, finder pattern search via module ratios,
perspective correction, zig-zag bit extraction and Reed-Solomon error correction. It tolerates
noise, uneven blackening, slight rotation and perspective distortion as they occur when scanning.

**Splitting batch scans:** every page with a QR code starts a new document; pages without a code
belong to the previous one. The parts are rebuilt as standalone PDFs and the **page images are
copied byte-for-byte** — nothing is recompressed. Metadata of the original such as the creation
date or an embedded text layer is lost. If splitting fails, the file is transferred unchanged as a whole.

## 8. Users and roles

As long as no user exists, Folderpost works without sign-in. As soon as the first user exists, sign-in is required.

| Role | May |
|---|---|
| Administrator | everything: delete jobs, manage users, settings, updates |
| User | create, change, pause, run and archive jobs |
| Viewer | view only |

Permissions are checked on the server.

- **Sessions:** after sign-in a random token is stored in a cookie (`HttpOnly`, `SameSite=Lax`).
  Sessions expire after 12 hours and are kept in memory — after a restart everyone signs in again.
- **Passwords:** PBKDF2 with 200,000 rounds and a random salt. After five failed attempts
  the account is locked; the waiting time grows with every further attempt up to 15 minutes.
- Stored passwords for target APIs and mail servers are never sent to the browser — the
  interface only shows whether one is set.

## 9. Encryption

The web interface itself speaks plain HTTP. For encrypted access put a reverse proxy in front
of it — for example Caddy, nginx or IIS with Application Request Routing — that accepts HTTPS
and forwards to `http://127.0.0.1:3000`. In that case bind Folderpost to `127.0.0.1` so that it
cannot be reached around the proxy.

Outgoing connections to HTTPS targets are encrypted by curl and verified as usual (unless you add
`-k`). E-mail uses STARTTLS or direct TLS. **Note:** for SMTP connections and notification
webhooks the TLS certificate is currently not verified, so that internal servers with
self-signed certificates work.

## 10. Operation

| Start method | Suitable for | Setting "Behaviour after installing" |
|---|---|---|
| `start.sh` / `start.bat` in a terminal | single workstation, testing | Restart itself |
| launchd (macOS), systemd (Linux) | permanent operation | Only stop |
| Scheduled task or service (Windows) | permanent operation | Only stop |

Folderpost detects from its environment which operating mode is likely and points out if the
setting does not match. See [running as a service](running-as-a-service.md).

**Updates:** a new package is uploaded as a ZIP file in **Settings → System & maintenance**.
A backup of the current state is made first. Configuration, logs, users and the `runtime/`
folder are kept. Archives without `server.js` or with paths outside the target folder are
rejected; if installing fails, the old state is restored. With a Git clone you can simply
`git pull` and restart instead.

**Self-check:** at start-up and regularly afterwards Folderpost checks whether source folders are
reachable, whether configurations are consistent and whether a job repeatedly finds no QR code.
Findings appear as hints in the interface.

## 11. Language

The interface is available in **English and German**; each browser chooses with the `DE`/`EN`
button in the header. Log entries, notification e-mails and webhooks are written in the language
chosen under **Settings → General**. Entries keep the language they were written in. Job names,
paths, file names and responses of receiving systems are not translated.

## 12. Limits

- **One process, one configuration.** Use several instances on different ports for separate
  environments. Never start two instances from the same folder — this can lead to duplicate transfers.
- **Overlapping filters:** two jobs on the same folder with overlapping filters take files away
  from each other. Folderpost warns about this.
- **Large files** are loaded into memory completely in the JSON format. Above roughly 200 MB use
  multipart or a folder target.
- **No OCR.** QR codes are evaluated, not text.
- **"Inspect sent data"** cannot show the individual parts of split batch scans again, because they are not stored.

## 13. Troubleshooting

| Observation | Possible cause |
|---|---|
| "Folder not reachable" | share not connected/mounted or the account lacks rights |
| Files stay in the folder | settle time not elapsed yet, or the time window applies |
| "No QR code found" | unsupported compression or code too small — the check image in the log helps |
| Receiving side reports an error | check the metadata with "Inspect sent data"; the `curl` command shown there can be run by hand |
| Interface not reachable | process not running, port in use or blocked by a firewall |
