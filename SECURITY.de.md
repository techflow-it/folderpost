# Sicherheitsrichtlinie

[English version](SECURITY.md)

## Unterstützte Versionen

Sicherheitskorrekturen erscheinen für die jeweils aktuelle Version.

| Version | Unterstützt |
|---|---|
| 1.0.x | ja |

## Sicherheitslücke melden

Bitte **kein öffentliches Issue** für Sicherheitsprobleme anlegen.
Meldungen bitte vertraulich über GitHub:
[Sicherheitslücke melden](https://github.com/TechFlow-IT/folderpost/security/advisories/new)
(Reiter **Security → Report a vulnerability** im Repository).

Bitte die betroffene Version, die Schritte zum Nachstellen und die erwartete Auswirkung angeben.
Wir bestätigen Meldungen möglichst innerhalb einer Woche und stimmen Korrektur und
Veröffentlichung mit dir ab.

## Hinweise zum Betrieb

- Ohne angelegte Benutzer kann jeder, der den Port erreicht, die Oberfläche bedienen.
  Vor dem Einsatz im Netzwerk einen Benutzer mit der Rolle „Verwaltung“ anlegen.
- Die Weboberfläche spricht unverschlüsseltes HTTP. Einen Reverse-Proxy mit HTTPS
  vorschalten und Folderpost auf `127.0.0.1` beschränken (`HOST=127.0.0.1`).
- `config.json` enthält Zugangsdaten für Schnittstellen und Mailserver im Klartext.
  Die Datei nur für das Dienstkonto und Administratoren lesbar machen.
- Bei SMTP-Verbindungen (Zielart E-Mail und Benachrichtigungs-E-Mails) und Benachrichtigungs-Webhooks
  werden TLS-Zertifikate derzeit nicht geprüft
  (damit interne Server mit selbst signierten Zertifikaten funktionieren). Diese
  Verbindungen daher nur in vertrauenswürdigen Netzen nutzen.
