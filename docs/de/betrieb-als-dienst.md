# Betrieb als Dienst

[English version](../en/running-as-a-service.md) · [README](../../README.de.md)

`start.sh` / `start.bat` genügen zum Ausprobieren. Für den Dauerbetrieb läuft Folderpost besser
als Hintergrunddienst — dann startet es mit dem Rechner und läuft nach dem Abmelden weiter.

Bei jeder Dienst-Variante unter **Einstellungen → System & Wartung → Verhalten nach dem
Einspielen** „**Nur beenden**“ wählen: Nach einer Aktualisierung startet der Dienstverwalter
Folderpost neu. Würde Folderpost sich selbst neu starten, kennte der Dienstverwalter den neuen
Vorgang nicht.

Die Beispiele gehen von `/opt/folderpost` (Linux), `/Users/Shared/folderpost` (macOS) bzw.
`C:\Tools\folderpost` (Windows) aus. Pfade bitte anpassen.

## Linux: systemd

Eigenen Benutzer anlegen und ihm Zugriff auf die Ordner geben, mit denen Folderpost arbeitet:

```sh
sudo useradd --system --home /opt/folderpost --shell /usr/sbin/nologin folderpost
sudo chown -R folderpost: /opt/folderpost
```

`/etc/systemd/system/folderpost.service`:

```ini
[Unit]
Description=Folderpost
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
User=folderpost
WorkingDirectory=/opt/folderpost
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
# Environment=HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now folderpost
journalctl -u folderpost -f
```

Liegen die Quellordner auf Netzwerkfreigaben, diese über `/etc/fstab` oder eine
systemd-Mount-Unit einhängen (siehe [Netzwerkfreigaben](netzwerkfreigaben.md));
`remote-fs.target` sorgt dafür, dass sie vorher eingehängt sind.

## macOS: launchd

Den Pfad von Node.js mit `which node` ermitteln (`/opt/homebrew/bin/node` auf Apple-Silicon-,
`/usr/local/bin/node` auf Intel-Macs).

`~/Library/LaunchAgents/io.github.techflow-it.folderpost.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.techflow-it.folderpost</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/Shared/folderpost</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/Shared/folderpost/data/folderpost.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/Shared/folderpost/data/folderpost.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.techflow-it.folderpost.plist
launchctl kickstart -k gui/$(id -u)/io.github.techflow-it.folderpost   # neu starten
launchctl bootout gui/$(id -u)/io.github.techflow-it.folderpost        # beenden und entladen
```

Ein LaunchAgent läuft, solange der Benutzer angemeldet ist, und kann die im Finder verbundenen
SMB-Freigaben nutzen. Ohne angemeldeten Benutzer die plist nach `/Library/LaunchDaemons/`
legen, einen Schlüssel `UserName` ergänzen und mit `sudo launchctl bootstrap system …` laden;
Netzwerkfreigaben müssen dann für diesen Benutzer eingehängt werden (siehe [Netzwerkfreigaben](netzwerkfreigaben.md)).

Beim ersten Zugriff auf Ordner wie Dokumente, Schreibtisch oder externe Laufwerke fragt macOS
unter Umständen nach einer Erlaubnis. Für einen Hintergrunddienst entweder Ordner außerhalb
dieser geschützten Orte verwenden oder Node.js unter Systemeinstellungen → Datenschutz &
Sicherheit **Festplattenvollzugriff** geben.

## Windows: geplante Aufgabe

Aufgabenplanung öffnen → **Aufgabe erstellen** (nicht „Einfache Aufgabe“):

- **Allgemein:** ein Konto mit Zugriff auf die Freigaben; „Unabhängig von der Benutzeranmeldung ausführen“.
- **Trigger:** „Beim Start“ (zusätzlich gern „Bei Anmeldung“).
- **Aktionen:** Programm `C:\Program Files\nodejs\node.exe` (oder
  `C:\Tools\folderpost\runtime\node-win-x64\node.exe`), Argumente `server.js`,
  Starten in `C:\Tools\folderpost`.
- **Einstellungen:** „Aufgabe neu starten, falls sie fehlschlägt“ alle 1 Minute, 999 Versuche;
  „Aufgabe beenden, falls sie länger läuft als …“ **ausschalten**; „Falls die Aufgabe bereits
  ausgeführt wird“: „Keine neue Instanz starten“.

## Windows: Dienst mit NSSM

NSSM von <https://nssm.cc> herunterladen und in einer Eingabeaufforderung als Administrator ausführen:

```bat
nssm install Folderpost
```

- Path: `C:\Program Files\nodejs\node.exe`
- Startup directory: `C:\Tools\folderpost`
- Arguments: `server.js`
- Exit actions: „Restart application“ beibehalten.

Das Dienstkonto braucht Zugriff auf die UNC-Pfade der Jobs (ein Domänenkonto oder ein lokales
Konto mit hinterlegten Zugangsdaten; `LocalSystem` hat meist keinen Zugriff auf Netzwerkfreigaben).

## Welche Einstellung ist richtig?

Unter **Einstellungen → System & Wartung** steht, welche Umgebung Folderpost erkannt hat und ob
das gewählte „Verhalten nach dem Einspielen“ dazu passt.
