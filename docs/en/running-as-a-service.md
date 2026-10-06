# Running as a service

[Deutsche Fassung](../de/betrieb-als-dienst.md) · [README](../../README.md)

`start.sh` / `start.bat` are fine for trying Folderpost out. For permanent operation run it as a
background service, so that it starts with the computer and keeps running after you sign out.

In every service setup, set **Settings → System & maintenance → Behaviour after installing** to
**Only stop**: after an update the service manager restarts Folderpost. If Folderpost restarted
itself instead, the service manager would not know the new process.

The examples assume Folderpost lives in `/opt/folderpost` (Linux), `/Users/Shared/folderpost`
(macOS) or `C:\Tools\folderpost` (Windows). Adjust the paths.

## Linux: systemd

Create a dedicated user and give it access to the folders Folderpost works with:

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

If the source folders are network shares, mount them via `/etc/fstab` or a systemd mount unit
(see [network shares](network-shares.md)); `remote-fs.target` makes sure they are mounted first.

## macOS: launchd

Find the path of Node.js with `which node` (`/opt/homebrew/bin/node` on Apple silicon,
`/usr/local/bin/node` on Intel Macs).

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
launchctl kickstart -k gui/$(id -u)/io.github.techflow-it.folderpost   # restart
launchctl bootout gui/$(id -u)/io.github.techflow-it.folderpost        # stop and unload
```

A LaunchAgent runs while the user is signed in and can use the SMB shares connected in the
Finder. To run without a signed-in user, put the plist into `/Library/LaunchDaemons/`, add a
`UserName` key and load it with `sudo launchctl bootstrap system …`; network shares then have
to be mounted for that user (see [network shares](network-shares.md)).

On first access to folders such as Documents, Desktop or external volumes, macOS may ask for
permission. For a background service, either use folders outside those protected locations or
grant Node.js **Full Disk Access** in System Settings → Privacy & Security.

## Windows: scheduled task

Open Task Scheduler → **Create Task** (not "Create Basic Task"):

- **General:** an account with access to the shares; "Run whether user is logged on or not".
- **Triggers:** "At startup" (optionally also "At log on").
- **Actions:** program `C:\Program Files\nodejs\node.exe` (or
  `C:\Tools\folderpost\runtime\node-win-x64\node.exe`), arguments `server.js`,
  start in `C:\Tools\folderpost`.
- **Settings:** enable "If the task fails, restart every 1 minute", attempts 999;
  **disable** "Stop the task if it runs longer than …"; "If the task is already running":
  "Do not start a new instance".

## Windows: service with NSSM

Download NSSM from <https://nssm.cc> and run in an administrator command prompt:

```bat
nssm install Folderpost
```

- Path: `C:\Program Files\nodejs\node.exe`
- Startup directory: `C:\Tools\folderpost`
- Arguments: `server.js`
- Exit actions: keep "Restart application".

The service account needs access to the UNC paths used by the jobs (a domain account or a
local account with stored credentials; `LocalSystem` usually has no access to network shares).

## Which setting is right?

**Settings → System & maintenance** shows which environment Folderpost detected and whether
the chosen "Behaviour after installing" fits.
