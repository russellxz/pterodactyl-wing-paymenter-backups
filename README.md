# PteroBackups

Web system for **remote** backups of [Pterodactyl](https://pterodactyl.io/) and [Paymenter](https://paymenter.org/). It runs on a separate VPS and, connecting over SSH, backs up:

- The **full panel database** (mysqldump) + the **`.env`** file (essential for reinstalls).
- The **full Paymenter database** (mysqldump) + its **`.env`** file, on its own automatic-backup timer.
- The **server files of every node (Wings)**, one `.zip` per server, named after the **owner's first name, last name and email** plus the **server name**, so you can find them instantly with the search box.

Everything is managed from a web page with a dark, mobile-friendly design, professional icons, real-time progress and error logging.

## Features

- **Manual** backups ("Back up now" button) and **automatic** ones (every 1 hour, 1, 7, 15 or 30 days).
- **Separate timers** for the nodes, the panel database and the Paymenter database: each with its own interval and its own live countdown, so they never run on the same day or at the same time.
- **Real-time search** by name, email or server.
- **Download** any backup from the web.
- **Restore** a single server, **all of them at once**, the **panel database** or the **Paymenter database** (to the same VPS or a brand-new one).
- **Automatic deletion** of old backups (configurable retention).
- **Administrators with customizable permissions**.
- **Real-time progress** and a live **logs** page.
- **Pterodactyl panel extension** so panel admins and users can manage/see their own backups from the panel itself.

## The web pages

- **Home** — overview: number of nodes, panels, Paymenter installations, stored backups, disk used and the current schedule.
- **Backups** — node backups organized by date, plus separate sections for panel-database and Paymenter-database backups.
- **Pterodactyl** — your Pterodactyl panels and nodes (Wings). Add, edit, delete and test each connection.
- **Paymenter** — a dedicated page for your Paymenter installations, with its own stats, its own "Back up Paymenter now" button and its own schedule. It's completely separate from Pterodactyl.
- **Settings** — schedule the three timers (nodes, panel DB, Paymenter DB), old-backup cleanup and the panel-extension key.
- **Administrators** — create admins and choose exactly what each one can do.
- **Logs** — live system activity and errors.

## Requirements

- A VPS for PteroBackups (Ubuntu/Debian recommended) with **Node.js 18+**.
- SSH access (IP + password) to: the panel VPS, every node, and the Paymenter VPS.
- The panel/Paymenter **database credentials** (they're in each `.env` file).
- `zip` and `unzip` installed **on every node and on the Paymenter VPS**:
  ```bash
  sudo apt update && sudo apt install -y zip unzip
  ```

## Installation

```bash
git clone <your-repo-url> pterobackups
cd pterobackups
npm install
```

Create a `.env` file in the project root:

```env
PORT=3500
HOST=127.0.0.1
SESSION_SECRET=change_this_for_a_long_random_string
ENCRYPTION_KEY=a_32_character_key_0123456789abcd
```

- `ENCRYPTION_KEY` must be **exactly 32 characters** — it encrypts the stored SSH and database passwords.
- Create the first (root) administrator:
  ```bash
  npm run create-admin
  ```
- Start it:
  ```bash
  npm start
  ```

The app listens on `127.0.0.1:3500`. Put **Nginx** in front of it with your domain and SSL.

### Run it as a service (systemd)

```ini
# /etc/systemd/system/pterobackups.service
[Unit]
Description=PteroBackups
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/pterodactyl-backup
ExecStart=/usr/bin/node src/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pterobackups
```

## First steps in the web UI

1. **Add your Pterodactyl panel** (Pterodactyl page): the VPS IP, SSH password and database details (`DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` from `/var/www/pterodactyl/.env`). You can add several.
2. **Add your nodes (Wings)** with their IP and SSH password, choosing which panel each belongs to.
3. **Using Paymenter?** Add it on the **Paymenter** page with its VPS IP, SSH password and database details (from `/var/www/paymenter/.env`).
4. **Schedule the backups** (Settings): set each timer and the retention.
5. **Run your first backup** ("Back up now"). Each run creates a "backup date" inside every node; open it in Backups to download or restore any server.

## Restoring

- **A single server** or **a whole date**: from Backups -> node -> date. You can restore on top of the current files or wipe them first.
- **The panel database** or **the Paymenter database**: from Backups, using the restore button in each section. You can restore to the **saved VPS** or to **another VPS** (useful for migrations). Each `.zip` also contains the original `.env` file.
- After restoring a database, if something looks off on Paymenter run `php artisan optimize:clear` on that VPS. After restoring servers whose volumes didn't exist, restart Wings on that node (`systemctl restart wings`).

## Updating

If you already have it installed as a service, updating keeps all your data (the database migrates automatically on startup):

```bash
cd /opt/pterodactyl-backup
sudo git pull
sudo npm install
sudo systemctl restart pterobackups
```

## Pterodactyl panel extension

The `extension/` folder contains a Pterodactyl extension so admins can trigger backups and every user can see their own server's backups from the panel. Install it following its own README, then paste the **URL** and **API key** (from Settings) into `https://YOUR-PANEL/admin/pterobackups`.

## Security notes

- All SSH and database passwords are stored **encrypted** with `ENCRYPTION_KEY`.
- Keep the app behind Nginx with SSL and never expose port 3500 directly.
- Root administrators can only be created from the console (`npm run create-admin`).
