# Security policy

[Deutsche Fassung](SECURITY.de.md)

## Supported versions

Security fixes are made for the latest release.

| Version | Supported |
|---|---|
| 1.0.x | yes |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Report them privately via GitHub:
[Report a vulnerability](https://github.com/TechFlow-IT/folderpost/security/advisories/new)
(repository tab **Security → Report a vulnerability**).

Please include the affected version, the steps to reproduce and the impact you expect.
We aim to acknowledge reports within a week and will coordinate a fix and disclosure with you.

## Operating notes

- Without user accounts, the web interface is open to everyone who can reach its port.
  Create an administrator before exposing Folderpost in a network.
- The web interface speaks plain HTTP. Put a reverse proxy with HTTPS in front of it and
  bind Folderpost to `127.0.0.1` (`HOST=127.0.0.1`).
- `config.json` contains credentials for target APIs and mail servers in plain text.
  Restrict it to the service account and administrators.
- For SMTP connections (e-mail targets and notification e-mails) and notification webhooks,
  TLS certificates are currently not verified
  (to support internal servers with self-signed certificates). Use trusted networks
  for these connections.
