# Network shares

[Deutsche Fassung](../de/netzwerkfreigaben.md) · [README](../../README.md)

A job's source folder (and a folder target) can be any path the Folderpost process can read
and write. Write access is needed because processed files are moved into subfolders
(`_sent`, `_error`, `_quarantine`).

## Windows

UNC paths work directly:

```
\\fileserver\share\incoming
```

The account Folderpost runs under needs access to the share. A mapped drive letter (`Z:`) only
exists in the session of the user who mapped it — use UNC paths for services and scheduled tasks.

## macOS

macOS has no UNC paths. Connect the share and use its mount point:

1. Finder → **Go → Connect to Server…** (⌘K), enter `smb://fileserver/share`, sign in and
   save the password in the keychain.
2. The share appears under `/Volumes/share`. In the job enter e.g. `/Volumes/share/incoming`.
3. To reconnect automatically after sign-in, add the share in System Settings → General →
   Login Items, or mount it from a script:

```sh
mkdir -p ~/mnt/share
mount_smbfs //user@fileserver/share ~/mnt/share
```

For a LaunchDaemon without a signed-in user, mount the share in a script that runs before
Folderpost (for example via a separate LaunchDaemon) and store the credentials in the
system keychain or in `~/Library/Preferences/nsmb.conf` of the service user.

## Linux

Mount the share with `cifs-utils` and use the mount point in the job:

```sh
sudo apt install cifs-utils
sudo mkdir -p /mnt/share
```

`/etc/fstab`:

```
//fileserver/share  /mnt/share  cifs  credentials=/etc/folderpost-smb.cred,uid=folderpost,gid=folderpost,iocharset=utf8,_netdev,nofail  0  0
```

`/etc/folderpost-smb.cred` (readable by root only, `chmod 600`):

```
username=svc-folderpost
password=…
domain=EXAMPLE
```

```sh
sudo mount -a
```

In the job enter e.g. `/mnt/share/incoming`. NFS shares are mounted the same way.

## Tips

- Use a **settle time** (minimum file age) of a few seconds for folders that scanners or other
  programs write to, so that half-written files are never sent.
- Do not let two jobs watch the same folder with overlapping filters; Folderpost warns about it.
- If the share is unavailable, the job shows "Folder not reachable" and simply retries at the next scan.
