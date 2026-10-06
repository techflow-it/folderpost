# Benachrichtigungen

[English version](../en/notifications.md) · [README](../../README.de.md)

Wandert eine Datei nach der eingestellten Anzahl Fehlversuche in die Quarantäne, kann Folderpost
das per E-Mail, per Webhook oder auf beiden Wegen melden. Eingerichtet wird das einmal für alle
Jobs unter **Einstellungen → Benachrichtigungen**. **Test senden** prüft alle aktivierten Kanäle.

Damit keine Flut entsteht, geht je Job **höchstens eine Benachrichtigung innerhalb von 15 Minuten** hinaus.
Benachrichtigungen werden in der Sprache geschrieben, die unter **Einstellungen → Allgemein** gewählt ist.

## E-Mail

| Feld | Beispiel |
|---|---|
| SMTP-Server | `smtp.example.org` |
| Port | `587` (STARTTLS), `465` (direkt TLS) oder `25` (unverschlüsselt) |
| Benutzer / Passwort | optional, für die SMTP-Anmeldung |
| Absender | `folderpost@example.org` |
| Empfänger | `betrieb@example.org, it@example.org` |

Beispiel:

```
Betreff: Folderpost: Datei in Quarantäne — Bestellungen → Partner-API

Job: Bestellungen → Partner-API
Datei: bestellung_1042.xml
Grund: HTTP 502 Bad Gateway
Zeitpunkt: 06.10.2026, 14:03:12

Folderpost (Adresse ggf. an das eigene Netz anpassen): http://server01:3000
```

## Webhook

Folderpost sendet einen HTTP-`POST` mit JSON-Rumpf an die eingetragene URL. Jede Antwort mit
Status 2xx gilt als Erfolg; die Zeitüberschreitung liegt bei 10 Sekunden. `grund` ist der
Fehler des letzten fehlgeschlagenen Versuchs.

```json
{
  "ereignis": "quarantaene",
  "job": "Bestellungen → Partner-API",
  "jobId": "j_1712345678",
  "datei": "bestellung_1042.xml",
  "grund": "HTTP 502 Bad Gateway",
  "zeitpunkt": "2026-10-06T12:03:12.000Z",
  "adresse": "http://server01:3000"
}
```

Der Test-Knopf sendet `{ "ereignis": "test", "meldung": "…", "zeitpunkt": "…" }`.

Die meisten Chat-Werkzeuge (Microsoft Teams, Slack, Mattermost, Rocket.Chat) erwarten ein
eigenes Nachrichtenformat; zum Umsetzen eignet sich ein kleiner Vermittler oder ein
Automatisierungswerkzeug (n8n, Node-RED, Power Automate).

**Hinweis:** TLS-Zertifikate von SMTP-Servern und Webhook-Adressen werden derzeit nicht geprüft,
damit interne Server mit selbst signierten Zertifikaten funktionieren. Diese Verbindungen daher
nur in vertrauenswürdigen Netzen nutzen.
