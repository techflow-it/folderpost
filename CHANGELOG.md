# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[Deutsche Fassung](CHANGELOG.de.md)

## [1.0.0] – 2026-10-06

First public release under the GNU GPL v3.0 or later.

### Added
- Jobs that watch a folder and deliver new files to an HTTP API (via `curl`),
  a folder or an e-mail address, with additional targets per job.
- Settle time, maximum file size, time windows, test mode and duplicate detection.
- Archive, error and quarantine subfolders; retries with exponential back-off.
- Scanned PDFs: QR code detection with built-in JPEG, CCITT Group 4 and QR decoders,
  JSON or multipart output with a metadata template, splitting of batch scans at QR codes.
- Web interface with overview, job details, transfer log, statistics, categories,
  templates, bulk actions, command palette, light and dark theme.
- Users with the roles administrator, user and viewer; sign-in lockout.
- Notifications by e-mail and webhook when a file is moved to quarantine.
- Self-check, configuration warnings, change log, configuration backups,
  export/import and update by uploading a ZIP package.
- English and German interface; logs and notifications in a configurable language.
- `PORT` and `HOST` environment variables and an optional `host` setting.
- Tests with synthetic PDF fixtures and a CI workflow for Linux, macOS and Windows.

[1.0.0]: https://github.com/TechFlow-IT/folderpost/releases/tag/v1.0.0
