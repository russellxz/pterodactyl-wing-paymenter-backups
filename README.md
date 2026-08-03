# PteroBackups — Backup system for Pterodactyl (panel + Wings) and Paymenter

Web-based remote backup system for Pterodactyl **and** Paymenter — not just the Pterodactyl panel, but also its server nodes (Wings) and your Paymenter billing panel. It installs on a separate VPS and, connecting over SSH, makes backups of:

• The panel's complete database (mysqldump) + the `.env` file (essential for reinstalls).
• The files of every server on every node (Wings), one `.zip` per server, named with the owner's first name, last name and email plus the server name, so you can find them instantly with the search box.
• **Paymenter, complete** (billing panel): the whole database, the `.env`, the files uploaded from the panel (logo, favicon, product images, invoices), the extensions you installed and your custom themes. Restore it to the same VPS or to a brand-new one without setting anything up by hand.

Everything is managed from a web page with a dark design, professional icons, real-time progress and error logging.

## Features

• Manual backups ("Back up now" button) and automatic backups (every 1 hour, 1, 7, 15 or 30 days).
• Real-time search by name, email or server.
• Download any backup from the web.
• Restore a specific server, all of them at once, or the panel DB (to the same VPS or a new one).
• Restore Paymenter whole — database + uploaded files + extensions + themes — to the same VPS or a new one, in one step.
• Automatic deletion of old backups (configurable retention).
• Administrators with customizable permissions.
• Real-time progress and a live logs page.
• SSH and DB passwords stored encrypted (AES-256) in a local SQLite database (no database to install: it creates itself in a file).

The extension for the Pterodactyl panel is included in the `extension/` folder: admins manage all backups from the panel's admin area, and each user views, downloads and restores the backups of THEIR server from a new "Backup 2.0" option in their menu. Compatible with the Arix v2 theme (it does not recompile the panel). Full instructions in `extension/README.md`.

───

## Before you start: 2 basics

**What is `sudo`?** It means "run as administrator". If you're already logged in as root, the commands work the same with or without `sudo`.

**What is `nano`?** It's the terminal's text editor. You'll use it several times. Here's how it works:

| Action | Key |
| --- | --- |
| Move through the text | Keyboard arrows |
| Paste copied text | Right click (or Ctrl + Shift + V) |
| Save | Ctrl + O then Enter |
| Exit | Ctrl + X |

───

## Requirements

| Where | What you need |
| --- | --- |
| System VPS (where you install this page) | Clean Ubuntu 22.04 or 24.04 and a domain added to Cloudflare |
| Pterodactyl panel VPS | SSH access with password + `zip` and `unzip` |
| Each node (Wings) | SSH access with password + `zip` and `unzip` |

On the panel VPS and on each node, run this (it installs the tools to compress and decompress the backups):

```bash
sudo apt update && sudo apt install -y zip unzip
```

**Important:** the SSH user you use (usually root) must be able to log in with a password. If your VPS only accepts keys, open the configuration with `sudo nano /etc/ssh/sshd_config`, find and set these lines: `PasswordAuthentication yes` and `PermitRootLogin yes`. Save, exit and restart SSH with `sudo systemctl restart ssh`.

───

## Step-by-step installation (system VPS)

### Step 1 — Install Node.js 22, Git and Nginx

```bash
# Update the list of available programs
sudo apt update

# Install: curl (download things), git (clone the project),
# build-essential and python3 (needed to compile the database),
# and nginx (the web server that will show the page)
sudo apt install -y curl git build-essential python3 nginx

# Add the official Node.js 22 repository (LTS version supported until 2027)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

# Install Node.js
sudo apt install -y nodejs

# Check that it installed correctly: it should show v22.x
node -v
```

**Had you already installed Node 18?** Run the first two commands anyway (they replace it with 22) and, if you had already run `npm install` in the project, rebuild the dependencies with: `cd /opt/pterodactyl-wing-paymenter-backups && sudo npm rebuild`

### Step 2 — Download the project

```bash
# Go into the /opt folder (where programs are usually installed)
cd /opt

# Download the project from GitHub
sudo git clone https://github.com/russellxz/pterodactyl-wing-paymenter-backups.git

# Go into the project folder
cd pterodactyl-wing-paymenter-backups

# Install the project dependencies (takes 1-3 minutes)
sudo npm install
```

### Step 3 — Configure the .env file (the secret key)

The `.env` file stores the system's private configuration. The most important thing is `APP_SECRET`: a key that protects login sessions and encrypts the SSH passwords you save. Each installation must have its own.

```bash
# Create your configuration from the example template
sudo cp .env.example .env

# Generate a secure random key. COPY the result that appears
openssl rand -hex 32

# Open the configuration to edit it
sudo nano .env
```

Inside nano, find the line that starts with `APP_SECRET=` and delete whatever is after the `=`, then paste your key. It should look something like this:

```
APP_SECRET=f3a91c0d8b27e6...your_long_key...
```

Save with Ctrl + O, Enter, and exit with Ctrl + X. You don't need to touch the rest of the file.

### Step 4 — Create your administrator account

```bash
sudo npm run create-admin
```

It will ask for first name, last name, email and password (minimum 8 characters). You'll log into the page with that account. Admins created from the console are root: they have every permission. If you ever forget the password, run this same command again with the same email and it will be reset.

### Step 5 — Keep the system always on (systemd)

This makes the page start on its own when the VPS boots and restart if it fails. The service already comes configured for the default installation (`/opt/pterodactyl-wing-paymenter-backups`), nothing needs editing.

```bash
# Copy the service file into the system
sudo cp deploy/pterobackups.service /etc/systemd/system/pterobackups.service
```

**Only if you cloned the project into ANOTHER folder:** open it with `sudo nano /etc/systemd/system/pterobackups.service` and change the `WorkingDirectory=` line to your real path.

Now enable the service:

```bash
# Reload systemd so it detects the new service
sudo systemctl daemon-reload

# Enable automatic startup and turn the system on now
sudo systemctl enable --now pterobackups

# Check that it's running: it should say "active (running)" in green
sudo systemctl status pterobackups
```

The app listens only internally on `127.0.0.1:3500`. No one can get in from outside yet: that's what Nginx is for (next step).

───

### Step 6 — Domain in Cloudflare

You need a subdomain for your page, for example `copias.yourdomain.com`.

1. Go to Cloudflare and choose your domain.
2. Go to DNS → Records → Add record and create:
   - Type: **A**
   - Name: **copias** (or whatever name you want)
   - IPv4 address: the IP of this VPS (the backup system's one)
   - Proxy status: enabled (orange cloud)
3. Go to SSL/TLS → Overview and set the mode to **Full (strict)**.
4. Go to SSL/TLS → Origin Server → Create Certificate:
   - Leave the default options and press Create.
   - It will show you two text boxes: the **Origin Certificate** and the **Private Key**. Leave that tab open, you'll copy them in the next step.

### Step 7 — Configure Nginx with the certificate

Nginx is the "front door": it receives visits to `https://copias.yourdomain.com` with the Cloudflare certificate and passes them internally to the app.

**7.1 — Save the Cloudflare certificate on the VPS:**

```bash
# Create the folder where the certificate and key will live
sudo mkdir -p /etc/ssl/cloudflare

# Open an empty file for the CERTIFICATE
sudo nano /etc/ssl/cloudflare/cert.pem
```

Paste the complete **Origin Certificate** from Cloudflare (from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`). Save and exit.

```bash
# Open an empty file for the PRIVATE KEY
sudo nano /etc/ssl/cloudflare/key.pem
```

Paste the complete **Private Key** (from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`). Save and exit.

```bash
# Protect the private key so only root can read it
sudo chmod 600 /etc/ssl/cloudflare/key.pem
```

**7.2 — Put YOUR domain in the Nginx configuration:**

```bash
# Copy the configuration included in the project
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pterobackups.conf

# Open it to set your domain
sudo nano /etc/nginx/sites-available/pterobackups.conf
```

Inside you'll see two lines that say:

```
server_name copias.yourdomain.com;
```

Change `copias.yourdomain.com` to your real subdomain on both lines (one is in the port 80 block and the other in the 443 block). Don't touch anything else. Save and exit.

**7.3 — Enable the site:**

```bash
# Enable the configuration (creates a "shortcut" in sites-enabled)
sudo ln -s /etc/nginx/sites-available/pterobackups.conf /etc/nginx/sites-enabled/

# Check there are no syntax errors: it should say "syntax is ok" and "test is successful"
sudo nginx -t

# Apply the changes
sudo systemctl reload nginx
```

**7.4 — (Only if you use the UFW firewall) open the web ports:**

```bash
sudo ufw allow 'Nginx Full'
```

Done. Open `https://copias.yourdomain.com` in your browser and log in with the account from Step 4.

───

## Using the page

1. **Nodes and Panels → Add panel.** Type a name, the panel VPS's IP, its SSH password and the database details. Those details are in the panel's `/var/www/pterodactyl/.env` file: `DB_USERNAME` (user), `DB_PASSWORD` (password) and `DB_DATABASE` (name, usually `panel`). You can view them with `cat /var/www/pterodactyl/.env` on the panel VPS. Press Test connection. You can add several panels.
2. **Nodes and Panels → Add node.** For each node (Wings): a name, its IP, its SSH password and which panel it belongs to. With the pencil you can edit any node or panel afterwards (for example, to change the SSH password).
3. **Settings.** Choose how often automatic backups run, what gets backed up and when old backups are deleted. With automatic backups active, you'll see a real-time countdown at the top showing the time until the next one.
4. **Backups.** Each pass creates a backup date inside each node: enter the node → choose the date → there you'll find every server with its owner and email, with a search box, to download, restore one, or restore the whole date (server files only: the panel DB is never touched). The panel DB backups are in their own section with their own restore button (to the same panel or to another VPS). The Paymenter DB backups have their own restore button too, and can be restored to the same VPS or to a new one, exactly like the panel. While a backup is running you can cancel it, and the progress stays visible even if you reload the page. The `.zip` files exclude `node_modules` and `package-lock.json`.
5. **Administrators.** Create more admins, ticking only the permissions you want to give them.
6. **Logs.** All activity and errors, in real time.

Backups are saved in `storage/backups/` inside the project (servers in `servers/`, DB in `panel/`, and the `.env` backups in `panel/env/`).

───

## Paymenter: complete backup and migration

Paymenter is a Laravel application. Reinstalling it (or cloning it on a new VPS) brings back all the code, but it does **not** bring back anything you added yourself. This system copies exactly that:

| What | Where it lives | Why it matters |
| --- | --- | --- |
| The whole database | `mysqldump` of your database | Includes **every table**, also the ones your extensions create. Nothing to configure: whatever exists in the database is dumped. |
| Uploaded files | `storage/app` | Logo, favicon, product images, invoices — everything uploaded from the panel. `storage/app/public` is the folder published through `storage:link`. |
| Installed extensions | `extensions/` | Payment gateways, server modules, etc. They are in Paymenter's `.gitignore`, so an update or a reinstall does not restore them. |
| Custom themes | `themes/` | Paymenter's `.gitignore` only keeps `default`. |
| OAuth keys | `storage/*.key` | Also gitignored. |
| The `.env` file | wherever you configured it | Restoring it is **optional** — see below. |

Not included (on purpose, because it regenerates itself and only makes the `.zip` heavier): `vendor/`, `node_modules/`, `storage/framework` (caches), logs and Livewire's half-finished uploads.

### Setting it up

On the **Paymenter** page, each installation has two extra fields:

- **Paymenter folder** — where it is installed, normally `/var/www/paymenter`. If you leave it blank it is worked out from the `.env` path.
- **What to back up** — *Everything* (the default) or *Database and `.env` only*, if you would rather keep the `.zip` small.

Nothing else to do: every backup, manual or scheduled, saves the whole installation. Each one also stores an inventory (tables, extensions, themes and Paymenter version) that you can see next to it in **Backups**.

### Migrating to another VPS

1. Install Paymenter on the new VPS the usual way and create its (empty) database.
2. In **Backups → Paymenter database backups**, open the day and press restore on the backup you want.
3. Choose **Another VPS (new Paymenter)** and fill in its IP, SSH password, database details and the Paymenter folder.
4. Leave **Uploaded files, extensions and themes** ticked.
5. Leave **Replace the `.env` file** unticked: the new VPS has its own database credentials and its own `APP_URL`, and replacing them would break it. Tick it only when you are restoring onto the **same** VPS (the current `.env` is saved next to it with a `.pb-backup-` suffix before being replaced).

The system imports the database, puts every file back in its place (merging, so nothing already on the destination is deleted), recreates the `storage` public link and clears Paymenter's caches. Ownership of the folder is handed back to the web user afterwards.

> Backups made before this feature existed only contain the database and the `.env`. They are still valid and still restore fine — they are marked *Database only*, and asking for files simply warns you there are none inside.

───

## Updating the system when there are new changes

When the repository has improvements, update your VPS like this:

```bash
# Go into the project folder
cd /opt/pterodactyl-wing-paymenter-backups

# Download the changes from GitHub
sudo git pull

# Install new dependencies (if any)
sudo npm install

# Restart the system to apply the changes
sudo systemctl restart pterobackups
```

───

## Extension for the Pterodactyl panel (Backup 2.0)

The extension connects your Pterodactyl panel with this backup page:

• **Panel admins:** a new PteroBackups section in the admin area with everything the page has: make backups on the spot, cancel, live progress, countdown to the next automatic backup, backup dates per node, server search by name or email, download, restore, delete and change the schedule.
• **Users:** a "Backup 2.0" option in their server's sidebar menu to view, download and restore ONLY their server's backups.
• Compatible with the Arix v2 theme and any other theme: the extension does not recompile the panel (which is what breaks themes), and the menu button copies the design of the active theme.

### Step 1 — Copy the connection details

On this backup page, go to Settings and look for the "Panel extension" card. There you'll find the two details you'll need: the system URL and the API key. Keep them handy (tap them to select and copy them).

### Step 2 — Install the extension on the panel VPS

Connect over SSH to the VPS where the Pterodactyl panel is installed (not the backup system's one, unless you have both on the same VPS) and run:

```bash
# Go into the /opt folder
cd /opt

# Download the project (if you already have the folder from before, skip this command)
sudo git clone https://github.com/russellxz/pterodactyl-wing-paymenter-backups.git

# Go into the extension folder
cd pterodactyl-wing-paymenter-backups/extension

# Install the extension into the panel
sudo bash install.sh
```

The installer copies the pieces into the panel, adds the routes and clears the caches. At the end it prints several lines starting with `OK:` and the message "PteroBackups extension installed successfully".

If your panel is not in the normal folder (`/var/www/pterodactyl`), tell it the path: `sudo bash install.sh /path/to/your/panel`

### Step 3 — Connect the panel with the backup system

1. Open `https://YOUR-PANEL/admin/pterobackups` (PteroBackups also appears in the admin area menu).
2. Paste the URL and API key from Step 1.
3. Press Save and test connection. It should say "Connection successful".

Reload the panel with Ctrl + F5, enter any server and you'll see "Backup 2.0" in your server's sidebar menu. The connection is saved in the panel's database: if you ever reinstall the panel with the same DB, just run `install.sh` again and it reconnects on its own.

### Updating the extension when there are changes

```bash
# On the panel VPS: download the changes and reinstall
cd /opt/pterodactyl-wing-paymenter-backups
sudo git pull
cd extension
sudo bash install.sh
```

### Uninstalling or diagnosing

```bash
# Remove the extension from the panel (the saved connection is kept)
cd /opt/pterodactyl-wing-paymenter-backups/extension && sudo bash uninstall.sh

# If something doesn't show up: prints a full diagnostic report
cd /opt/pterodactyl-wing-paymenter-backups/extension && sudo bash check.sh
```

More details and troubleshooting for the extension in `extension/README.md`.

───

## Troubleshooting

• **The page won't load:** check the system with `sudo systemctl status pterobackups` and watch the live errors with `sudo journalctl -u pterobackups -f`. Also check Nginx with `sudo nginx -t`.
• **Cloudflare 521/522 error:** Nginx is off or the firewall is blocking ports 80/443. Check `sudo systemctl status nginx` and step 7.4.
• **`npm install` fails on better-sqlite3:** you're missing `build-essential` and `python3` (Step 1).
• **Test connection fails:** check that you can log in manually with `ssh root@NODE_IP` using that password and that port 22 isn't blocked.
• **Backups come out as "Unknown":** the panel DB details are wrong; check them in "Nodes and Panel" and use Test connection.
• **A server is skipped as "empty":** its volume has no files yet; that's normal.
• **I changed APP_SECRET and nothing connects:** the saved passwords are encrypted with that key; re-enter the node and panel passwords on the web.
• **"The server's host key changed":** you no longer have to do anything. If you reinstall, migrate or rebuild a VPS, its SSH key changes; the system clears the old fingerprint, trusts the new key and carries on with the backup, leaving a warning in **Logs** with the old and new fingerprints. If you did not touch that VPS, review the warning — an unexpected key change is worth looking into.

## Security notes

• Use strong SSH passwords and, if you can, limit the nodes' SSH by firewall to this VPS's IP.
• Don't open port 3500 to the outside: the app only listens on `127.0.0.1` and is served through Nginx over HTTPS.
• This VPS stores (encrypted) credentials of your other VPSs: protect it just as well as the panel.

## Roadmap

- [x] Phase 1: web page for the backup system.
- [x] Phase 2: extension for the Pterodactyl panel (`extension/` folder): full management from the admin area, backups viewable/downloadable/restorable by each user on their server, compatible with the Arix v2 theme.

## License

MIT. Use it, modify it and share it freely.
