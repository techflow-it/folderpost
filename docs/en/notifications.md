# Notifications

[Deutsche Fassung](../de/benachrichtigungen.md) · [README](../../README.md)

When a file is moved to quarantine after the configured number of failed attempts, Folderpost
can report this by e-mail, by webhook or both. Notifications are configured once for all jobs
under **Settings → Notifications**. **Send test** checks all enabled channels.

To avoid floods, at most **one notification per job within 15 minutes** is sent.
Notifications are written in the language chosen under **Settings → General**.

## E-mail

| Field | Example |
|---|---|
| SMTP server | `smtp.example.org` |
| Port | `587` (STARTTLS), `465` (direct TLS) or `25` (unencrypted) |
| User / password | optional, for SMTP authentication |
| Sender | `folderpost@example.org` |
| Recipients | `ops@example.org, it@example.org` |

Example:

```
Subject: Folderpost: file moved to quarantine — Orders → Partner API

Job: Orders → Partner API
File: order_1042.xml
Reason: HTTP 502 Bad Gateway
Time: 06/10/2026, 14:03:12

Folderpost (adjust the address to your network if necessary): http://server01:3000
```

## Webhook

Folderpost sends an HTTP `POST` with a JSON body to the configured URL. Any response with a
2xx status counts as success; the timeout is 10 seconds. `grund` (reason) is the error
of the last failed attempt.

```json
{
  "ereignis": "quarantaene",
  "job": "Orders → Partner API",
  "jobId": "j_1712345678",
  "datei": "order_1042.xml",
  "grund": "HTTP 502 Bad Gateway",
  "zeitpunkt": "2026-10-06T12:03:12.000Z",
  "adresse": "http://server01:3000"
}
```

The test button sends `{ "ereignis": "test", "meldung": "…", "zeitpunkt": "…" }`.
The field names are kept in German for compatibility with existing receivers.

Most chat tools (Microsoft Teams, Slack, Mattermost, Rocket.Chat) expect their own payload
format; use a small relay or an automation tool (n8n, Node-RED, Power Automate) to convert it.

**Note:** TLS certificates of SMTP servers and webhook URLs are currently not verified, so that
internal servers with self-signed certificates work. Use trusted networks for these connections.
