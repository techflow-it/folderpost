# Contributing to Folderpost

Thank you for your interest! Bug reports, ideas and pull requests are welcome.

[Deutsche Fassung](CONTRIBUTING.de.md)

## Reporting bugs and ideas

Use the [issue templates](https://github.com/TechFlow-IT/folderpost/issues/new/choose).
Please do **not** attach real documents, configuration files with credentials or
internal host names — reduce the problem to a synthetic example.
Security issues go through the [security policy](SECURITY.md), not public issues.

## Development setup

```sh
git clone https://github.com/TechFlow-IT/folderpost.git
cd folderpost
node server.js            # http://localhost:3000
npm test                  # node:test, no dependencies
```

The i18n acceptance test needs Python and Playwright:

```sh
pip3 install playwright && python3 -m playwright install chromium
python3 tools/i18n-scan.py            # no German in the English UI
python3 tools/i18n-scan.py --lang de  # no English in the German UI
python3 tools/xss-scan.py             # no user data is executed as HTML
```

Screenshots and test PDFs are generated, never real:

```sh
python3 tools/screenshots.py          # docs/img/ with demo data (tools/demo-data.py)
python3 tools/make-fixtures.py        # tests/fixtures/ (needs Pillow and qrencode)
```

## Code style

- Node.js ≥ 18, CommonJS, **no runtime dependencies** — please keep it that way.
- Two-space indentation, single quotes, semicolons (see `.editorconfig`).
- English is the source language for code, comments and texts.
  Every user-visible text goes through `t()` (browser), `T()` (API response) or
  `L()` (log, e-mail, webhook) and needs a German entry in `public/locales/de.json`.
- Every source file starts with the SPDX header:
  ```js
  // SPDX-License-Identifier: GPL-3.0-or-later
  // Copyright (C) 2026 TechFlow IT
  ```
- Test data must be synthetic. Never commit real scans, customer data or internal paths.

## Pull requests

- One topic per pull request; describe what changes and why.
- `npm test` and both i18n scans must pass; CI runs them on Linux, macOS and Windows.
- Add an entry under "Unreleased" in `CHANGELOG.md` and `CHANGELOG.de.md`.

## Developer Certificate of Origin

By contributing you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
you wrote the change or otherwise have the right to submit it under the project's license.
Sign off every commit:

```sh
git commit -s -m "Describe the change"
```

This adds a line `Signed-off-by: Your Name <you@example.org>`. Contributions are
licensed under the GNU GPL v3.0 or later.
