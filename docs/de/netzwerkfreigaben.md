# Netzwerkfreigaben

[English version](../en/network-shares.md) · [README](../../README.de.md)

Quell-Ordner eines Jobs (und ein Ordnerziel) kann jeder Pfad sein, den der Folderpost-Vorgang
lesen und beschreiben darf. Schreibrechte sind nötig, weil verarbeitete Dateien in Unterordner
(`_sent`, `_error`, `_quarantine`) verschoben werden.

## Windows

UNC-Pfade funktionieren direkt:

```
\\fileserver\share\eingang
```

Das Konto, unter dem Folderpost läuft, braucht Zugriff auf die Freigabe. Ein verbundener
Laufwerksbuchstabe (`Z:`) existiert nur in der Sitzung des Benutzers, der ihn verbunden hat —
für Dienste und geplante Aufgaben daher UNC-Pfade verwenden.

## macOS

UNC-Pfade gibt es unter macOS nicht. Die Freigabe verbinden und ihren Einhängepunkt verwenden:

1. Finder → **Gehe zu → Mit Server verbinden …** (⌘K), `smb://fileserver/share` eingeben,
   anmelden und das Passwort im Schlüsselbund sichern.
2. Die Freigabe erscheint unter `/Volumes/share`. Im Job z. B. `/Volumes/share/eingang` eintragen.
3. Damit die Verbindung nach der Anmeldung wiederhergestellt wird, die Freigabe unter
   Systemeinstellungen → Allgemein → Anmeldeobjekte ergänzen oder per Skript einhängen:

```sh
mkdir -p ~/mnt/share
mount_smbfs //benutzer@fileserver/share ~/mnt/share
```

Für einen LaunchDaemon ohne angemeldeten Benutzer die Freigabe in einem Skript einhängen, das vor
Folderpost läuft (etwa über einen eigenen LaunchDaemon), und die Zugangsdaten im
System-Schlüsselbund oder in `~/Library/Preferences/nsmb.conf` des Dienstbenutzers hinterlegen.

## Linux

Die Freigabe mit `cifs-utils` einhängen und den Einhängepunkt im Job verwenden:

```sh
sudo apt install cifs-utils
sudo mkdir -p /mnt/share
```

`/etc/fstab`:

```
//fileserver/share  /mnt/share  cifs  credentials=/etc/folderpost-smb.cred,uid=folderpost,gid=folderpost,iocharset=utf8,_netdev,nofail  0  0
```

`/etc/folderpost-smb.cred` (nur für root lesbar, `chmod 600`):

```
username=svc-folderpost
password=…
domain=EXAMPLE
```

```sh
sudo mount -a
```

Im Job z. B. `/mnt/share/eingang` eintragen. NFS-Freigaben werden genauso eingehängt.

## Tipps

- Für Ordner, in die Scanner oder andere Programme schreiben, eine **Ruhezeit** (Mindestalter)
  von einigen Sekunden einstellen, damit nie halb geschriebene Dateien gesendet werden.
- Nicht zwei Jobs mit überlappendem Filter auf denselben Ordner ansetzen; Folderpost warnt davor.
- Ist die Freigabe nicht verfügbar, zeigt der Job „Ordner nicht erreichbar“ und versucht es beim nächsten Scan erneut.
