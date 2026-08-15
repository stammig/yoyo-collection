# Running the Yoyo Collection on macOS or Windows

Works well, with one caveat worth stating up front: **a desktop OS isn't a
server**. It sleeps, reboots for updates on its own schedule, and if it's a
laptop it leaves the house. Fine for a personal catalog on the machine you use;
weaker as the household's always-available collection — for that, see
[DEPLOY-NAS.md](DEPLOY-NAS.md).

**Run it natively, not in Docker.** That's the reverse of the NAS advice, and
[§1](#1-why-native-and-not-docker) explains why.

---

# Part 1 — the parts that are the same on both

## 1. Why native, and not Docker

Docker Desktop runs your containers inside a **Linux VM** on both platforms.
Reaching a host file from inside that VM crosses a translation layer —
VirtioFS/gRPC-FUSE on macOS, 9p/DrvFs via WSL2 on Windows — and SQLite's locking
assumes a real local filesystem. Databases on Docker Desktop bind mounts are a
well-documented source of silent corruption and eternal locks, because SQLite's
OS primitives don't behave predictably across that boundary.

It's the same hazard that rules out mergerfs, Unraid's shfs, and NFS in the NAS
guide — just wearing a different hat.

Running natively, the database sits directly on **APFS** or **NTFS** with no
translation layer, and there's nothing to install beyond Node:

- `node:sqlite` is **built into Node** — nothing compiles
- `sharp` ships prebuilt binaries for `darwin-arm64`, `darwin-x64`, `win32-x64`
- there's no build step for the front end

On Windows that also means **no build tools and no Visual Studio C++ workload**.

If you'd rather use Docker anyway, see
[Using Docker instead](#using-docker-instead) — viable, with one required change.

## 2. Node 22.13 or newer

That minor version matters. `node:sqlite` landed in Node 22.5 behind
`--experimental-sqlite` and was only unflagged in **22.13.0**. On 22.5–22.12 the
app crashes at startup with an unknown-builtin error. Node 24 LTS is fine too.

```
node --version        # must be v22.13.0 or higher
```

## 3. Keep the folder out of cloud sync ⚠️

**This is the desktop equivalent of the NAS filesystem rule** — the thing that
quietly destroys the collection.

Both platforms now redirect Desktop and Documents to cloud storage by default —
**iCloud Drive** on macOS, **OneDrive** on Windows — and both have an
"optimize storage" feature that evicts files which look idle. They copy the
`.db` file mid-write and have no idea the `-wal` and `-shm` sidecars must stay
consistent with it. That's a corrupted collection.

- **Good:** `~/Apps/yoyo-collection` (macOS), `C:\Apps\yoyo-collection` (Windows)
- **Bad:** anything under Documents or Desktop with sync enabled

The same applies to Dropbox and Google Drive folders. The app's **backup zip**
is what belongs in those services — never the live database.

## 4. Configuration, if you need any

On a trusted LAN you need none. Leave `ADMIN_PASSWORD` unset and run fully open
— the owner-login split exists to keep a *public* instance read-only for
visitors, and you have none. Same for `RATE_LIMIT_MAX`.

If you do need settings: **there's no dotenv in this project.** A `.env` file is
read by Docker Compose's `env_file:` directive, but `npm start` ignores it
completely. Use Node's own flag:

```
node --env-file=.env server.js
```

Copy `.env.example` to `.env` next to `server.js`. This also sidesteps Windows
having no `FOO=bar command` syntax.

## 5. Backups

**Settings ⚙ → Backup** in the app produces one zip containing the database and
every photo. That's the file to keep in iCloud/OneDrive, on a NAS, or on an
external drive.

Time Machine and File History will also pick up the folder, but can capture the
database mid-write. WAL recovers from that cleanly in practice, so they're a
reasonable safety net — just not your only one.

> ⚠️ Never point a sync service at the live `yoyos.db`. It copies mid-write and
> doesn't understand the `-wal` / `-shm` sidecars. The zip has no such problem.

## 6. Reaching it from outside the LAN

Install **Tailscale** and you're there — no port forwarding, nothing exposed to
the internet, no changes to the app. See
[REMOTE-ACCESS.md](REMOTE-ACCESS.md) for that and the other options.

---

# Platform notes

## macOS

Works on both Apple Silicon and Intel.

**Install and run:**

```bash
brew install node@22          # or: brew install node
git clone https://github.com/stammig/yoyo-collection.git ~/Apps/yoyo-collection
cd ~/Apps/yoyo-collection
npm install
npm start
```

Open **http://localhost:3000**. Database and photos are created under `data/`
and `uploads/` — both git-ignored.

**On your LAN:** `ipconfig getifaddr en0` (try `en1` for Ethernet), then
`http://THAT-IP:3000`. Bonjour usually also gives you
`http://your-mac-name.local:3000`, which survives DHCP changes. macOS prompts to
allow incoming connections the first time — allow it, or it stays reachable only
from the Mac.

**Stop it sleeping:** System Settings → Displays → Advanced → *Prevent automatic
sleeping when the display is off*. For a one-off, `caffeinate -s npm start`.

**Start at login** — save as `~/Library/LaunchAgents/com.yoyo.collection.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.yoyo.collection</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/Apps/yoyo-collection/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/Apps/yoyo-collection</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/yoyo.log</string>
  <key>StandardErrorPath</key><string>/tmp/yoyo.err</string>
</dict>
</plist>
```

Substitute your username, and check `which node` — Intel Macs use
`/usr/local/bin/node`. Load it with
`launchctl load ~/Library/LaunchAgents/com.yoyo.collection.plist`.

A LaunchAgent runs at *login*, not boot. If the Mac must serve without anyone
logged in, put the plist in `/Library/LaunchDaemons/` and load it with `sudo`.

**Update:** `git pull && npm install`, then
`launchctl kickstart -k gui/$UID/com.yoyo.collection`.

## Windows

**Install and run:**

```powershell
winget install OpenJS.NodeJS.LTS
git clone https://github.com/stammig/yoyo-collection.git C:\Apps\yoyo-collection
cd C:\Apps\yoyo-collection
npm install
npm start
```

No Git? Download the repo as a ZIP from GitHub and extract to `C:\Apps\`. You do
**not** need the installer's "Tools for Native Modules" checkbox.

Open **http://localhost:3000**. Database and photos are created under `data\`
and `uploads\` — both git-ignored.

**On your LAN:** `ipconfig`, find the IPv4 address of your active adapter, then
`http://THAT-IP:3000`. Defender will prompt on first run — **allow it on Private
networks**. If you dismissed it, from an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Yoyo Collection" -Direction Inbound `
  -LocalPort 3000 -Protocol TCP -Action Allow -Profile Private
```

Keep it to `-Profile Private` — you don't want this open on public Wi-Fi.

**Stop it sleeping:** Settings → System → Power & battery → Screen and sleep →
*Sleep: Never* (at least when plugged in).

**Start at logon** with Task Scheduler → **Create Task** (not *Basic Task*):

- **General:** tick *Run whether user is logged on or not*
- **Triggers:** New → *At startup* (or *At log on*)
- **Actions:** New → Start a program
  - **Program:** `C:\Program Files\nodejs\node.exe`
  - **Arguments:** `server.js`
  - **Start in:** `C:\Apps\yoyo-collection`
- **Settings:** tick *If the task fails, restart every 1 minute*, and **untick
  *Stop the task if it runs longer than*** — it defaults to 3 days and will kill
  the server.

For a proper service with automatic restarts, [NSSM](https://nssm.cc) wraps
`node.exe` cleanly.

**Update:** `git pull; npm install`, then restart the task.

**Windows on ARM** (Snapdragon X and similar) works — Node ships `win32-arm64`
and `sharp` has matching prebuilds.

---

## Using Docker instead

Viable on both platforms, but change one thing: **use a named volume, never a
bind mount to a host path.** The named volume lives inside the Linux VM on a
real ext4 filesystem, which is what SQLite needs. A bind mount to `~/…` or
`C:\…` puts the database on the wrong side of the translation layer — exactly
where the corruption reports come from.

This inverts the NAS guide's advice, where bind mounts are correct because the
host filesystem is already Linux.

The repo's stock `docker-compose.yml` already does the right thing:

```yaml
volumes:
  - yoyo-data:/data          # ✅ named volume — inside the VM
# - ~/yoyo-data:/data        # ❌ bind mount — crosses the translation layer
```

```
docker compose up -d
```

The tradeoff: a named volume is awkward to back up from the host. Use the app's
**Settings ⚙ → Backup** zip as your backup mechanism rather than copying files.
Update with `docker compose pull && docker compose up -d`.

Running under **WSL2 directly** (Ubuntu, native Node, files in `/home/you/…` and
*not* `/mnt/c/…`) is also perfectly safe — that's a real Linux filesystem. At
that point follow [DEPLOY-NAS.md](DEPLOY-NAS.md) instead.

---

## Notes / gotchas

- **Node 22.13 is a hard floor**, but `package.json` pins `"node": "22.x"` —
  which technically allows 22.5–22.12, where the app won't start. The Docker
  image dodges this; native installs don't.

- **Run exactly one instance.** SQLite is single-writer, and the app's rate
  limiter and update cache are in-process. Don't run a native install and a
  container against the same data.

- **Restore is the memory-hungry endpoint.** Backup streams; restore buffers the
  upload (up to 200 MB) plus the parsed archive. Rarely an issue on a desktop.

- **`sharp` failing isn't fatal.** The app boots anyway and serves full-size
  images without thumbnails, logging a warning.

- **Antivirus can slow bulk uploads** on Windows — real-time scanning inspects
  every written photo and thumbnail. Exclude `uploads\` if imports crawl.

- **Port 3000 is popular** with dev tooling. `PORT=8080 npm start` on macOS, or
  `$env:PORT=8080; npm start` in PowerShell.
