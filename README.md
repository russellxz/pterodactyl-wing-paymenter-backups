# PteroBackups

Remote **backup** web system for [Pterodactyl](https://pterodactyl.io/) and [Paymenter](https://paymenter.org/). It is installed on a separate VPS and, by connecting through SSH, it backs up:

- The **full panel database** (`mysqldump`) + the **`.env`** file (essential for reinstalls).
- The **full Paymenter database** (`mysqldump`) + its **`.env`** file, with its own automatic-backup timer.
- The **files of each server on each node (Wings)**, one `.zip` per server, named with the **owner’s first name, last name, and email** and the **server name**, so you can find them instantly with the search bar.

Everything is managed from a web page with a dark, mobile-friendly design, professional icons, real-time progress, and error logs.

## Features

- **Manual** backups (“Make backup now” button) and **automatic** backups (every 1 hour, 1, 7, 15, or 30 days).
- **Separate timers** for the nodes, the panel database, and the Paymenter database: each one with its own interval and its own real-time counter, so they do not run on the same day or at the same hour.
- **Real-time search** by name, email, or server.
- **Download** any backup from the web.
- **Restore** a specific server, **all at once**, the **panel database**, or the **Paymenter database** (to the same VPS or to a new one).
- **Automatic deletion** of old backups (configurable retention).
- **Administrators with customizable permissions**.
- **Real-time progress** and live **logs** page.
- SSH and database passwords stored **encrypted** (AES-256) in a local SQLite database (you do not need to install any database: it creates itself in a file).

> The **extension for the Pterodactyl panel** is included in the [`extension/`](extension/) folder: admins manage all backups from the panel admin area, and each user can view, download, and restore the backups of THEIR server from a new “Backup 2.0” option in their menu. **Compatible with the Arix v2 theme** (it does not recompile the panel). Full instructions in [`extension/README.md`](extension/README.md).

---

## Before you start: 2 basic things

**What is `sudo`?** It means “run as administrator”. If you are already connected as `root`, the commands work the same with or without `sudo`.

**What is `nano`?** It is the terminal text editor. You will use it several times. This is how to use it:

| Action | Key |
|---|---|
| Move through the text | Keyboard arrows |
| Paste copied text | Right click (or `Ctrl + Shift + V`) |
| **Save** | `Ctrl + O` and then `Enter` |
| **Exit** | `Ctrl + X` |

---

## Requirements

| Where | What is needed |
|---|---|
| **System VPS** (where you install this page) | Clean Ubuntu 22.04 or 24.04 and a domain added to Cloudflare |
| **Pterodactyl panel VPS** | SSH access with password + `zip` and `unzip` |
| **Each node (Wings)** | SSH access with password + `zip` and `unzip` |
| **Paymenter VPS** (optional, if you use Paymenter) | SSH access with password + `zip` and `unzip` |

On the **panel VPS**, on **each node**, and on the **Paymenter VPS**, run this (installs the tools to compress and decompress backups):

```bash
sudo apt update && sudo apt install -y zip unzip
```

> **Important:** the SSH user you use (usually `root`) must be able to log in **with a password**. If your VPS only accepts keys, open the configuration with `sudo nano /etc/ssh/sshd_config`, find and set these lines like this: `PasswordAuthentication yes` and `PermitRootLogin yes`. Save, exit, and restart SSH with `sudo systemctl restart ssh`.

---

## Step-by-step installation (System VPS)

### Step 1 — Install Node.js 22, Git, and Nginx

```bash
# Update the list of available packages
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

> **Had you already installed Node 18?** Run the first two commands anyway (they replace it with 22) and, if you had already run `npm install` in the project, rebuild the dependencies with: `cd /opt/pterodactyl-backup && sudo npm rebuild`

### Step 2 — Download the project

```bash
# Enter the /opt folder (where programs are usually installed)
cd /opt

# Download the project from GitHub
sudo git clone https://github.com/russellxz/pterodactyl-backup.git

# Enter the project folder
cd pterodactyl-backup

# Install the project dependencies (takes 1-3 minutes)
sudo npm install
```

### Step 3 — Configure the .env file (the secret key)

The `.env` file stores the system’s private configuration. The most important part is `APP_SECRET`: a key that protects login sessions and **encrypts the SSH passwords** you save. Each installation must have its own.

```bash
# Create your configuration from the example template
sudo cp .env.example .env

# Generate a secure random key. COPY the result that appears
openssl rand -hex 32

# Open the configuration to edit it
sudo nano .env
```

Inside nano, find the line that starts with `APP_SECRET=` and delete everything after the `=` and paste your key. It should look something like this:

```
APP_SECRET=f3a91c0d8b27e6...your_long_key...
```

Save with `Ctrl + O`, `Enter`, and exit with `Ctrl + X`. You do not need to touch the rest of the file.

### Step 4 — Create your administrator account

```bash
sudo npm run create-admin
```

It will ask for first name, last name, email, and password (minimum 8 characters). You will use that account to log in to the page. Admins created from the console are **root**: they have all permissions. If one day you forget the password, run this same command again with the same email and it will be reset.

### Step 5 — Keep the system always running (systemd)

This makes the page start automatically when the VPS turns on and restart if it fails. The service already comes configured for the default installation (`/opt/pterodactyl-backup`), so you do not need to edit anything.

```bash
# Copy the service file to the system
sudo cp deploy/pterobackups.service /etc/systemd/system/pterobackups.service
```

> Only if you cloned the project into ANOTHER different folder: open it with `sudo nano /etc/systemd/system/pterobackups.service` and change the `WorkingDirectory=` line to your real path.

Now enable the service:

```bash
# Reload systemd so it detects the new service
sudo systemctl daemon-reload

# Enable automatic startup and start the system now
sudo systemctl enable --now pterobackups

# Check that it is running: it should say "active (running)" in green
sudo systemctl status pterobackups
```

The app will listen only internally on `127.0.0.1:3500`. Nobody can access it from outside yet: that is what Nginx is for (next step).

---

## Step 6 — Domain in Cloudflare

You need a subdomain for your page, for example `backups.yourdomain.com`.

1. Go to [Cloudflare](https://dash.cloudflare.com) and choose your domain.
2. Go to **DNS → Records → Add record** and create:
   - **Type:** `A`
   - **Name:** `backups` (or the name you want)
   - **IPv4 address:** the IP of this VPS (the backup system VPS)
   - **Proxy status:** enabled (orange cloud)
3. Go to **SSL/TLS → Overview** and set the mode to **Full (strict)**.
4. Go to **SSL/TLS → Origin Server → Create Certificate**:
   - Leave the default options and click **Create**.
   - It will show two text boxes: the **Origin Certificate** (certificate) and the **Private Key** (private key). **Leave that tab open**, you will copy them in the next step.

## Step 7 — Configure Nginx with the certificate

Nginx is the “entry door”: it receives visits to `https://backups.yourdomain.com` with the Cloudflare certificate and passes them internally to the app.

**7.1 — Save the Cloudflare certificate on the VPS:**

```bash
# Create the folder where the certificate and key will live
sudo mkdir -p /etc/ssl/cloudflare

# Open an empty file for the CERTIFICATE
sudo nano /etc/ssl/cloudflare/cert.pem
```

Paste the full Cloudflare **Origin Certificate** (from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`). Save and exit.

```bash
# Open an empty file for the PRIVATE KEY
sudo nano /etc/ssl/cloudflare/key.pem
```

Paste the full **Private Key** (from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`). Save and exit.

```bash
# Protect the private key so only root can read it
sudo chmod 600 /etc/ssl/cloudflare/key.pem
```

**7.2 — Put YOUR domain in the Nginx configuration:**

```bash
# Copy the configuration included in the project
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pterobackups.conf

# Open it to put your domain
sudo nano /etc/nginx/sites-available/pterobackups.conf
```

Inside you will see **two** lines that say:

```
server_name backups.yourdomain.com;
```

Change `backups.yourdomain.com` to your real subdomain **in both lines** (one is in the port 80 block and the other is in the 443 block). Do not touch anything else. Save and exit.

**7.3 — Enable the site:**

```bash
# Enable the configuration (creates a "shortcut" in sites-enabled)
sudo ln -s /etc/nginx/sites-available/pterobackups.conf /etc/nginx/sites-enabled/

# Check that there are no writing errors: it should say "syntax is ok" and "test is successful"
sudo nginx -t

# Apply the changes
sudo systemctl reload nginx
```

**7.4 — (Only if you use UFW firewall) open the web ports:**

```bash
sudo ufw allow 'Nginx Full'
```

**Done.** Open `https://backups.yourdomain.com` in your browser and log in with the account from Step 4.

---

## Page usage guide

1. **Nodes and Panels → Add panel.** Enter a name, the panel VPS IP, its SSH password, and the database details. Those details are in the `/var/www/pterodactyl/.env` file **of the panel**: `DB_USERNAME` (user), `DB_PASSWORD` (password), and `DB_DATABASE` (name, usually `panel`). You can view them with `cat /var/www/pterodactyl/.env` on the panel VPS. Click **Test connection**. You can add **multiple panels**.
2. **Nodes and Panels → Add node.** For each node (Wings): a name, its IP, its SSH password, and **which panel it belongs to**. With the pencil icon you can edit any node or panel later (for example, to change the SSH password).
3. **Nodes and Panels → Add Paymenter** (if you use [Paymenter](https://paymenter.org/) as your billing panel). Enter a name, the Paymenter VPS IP, its SSH password, and its database details, which are in `/var/www/paymenter/.env` **on the Paymenter VPS**: `DB_USERNAME` (user, usually `paymenter`), `DB_PASSWORD` (password), and `DB_DATABASE` (name, usually `paymenter`). Click **Test connection**. You can add **multiple installations**. On the Paymenter VPS also install `zip` and `unzip`.
4. **Settings.** Choose how often automatic backups are made — the **nodes**, the **panel database**, and the **Paymenter database** each have **their own timer**, so you can schedule them on different days or hours — and when old backups are deleted. With automatic backups enabled, you will see **real-time counters** at the top showing how long until each one.
5. **Backups.** Each run creates a **backup date** inside each node: enter the node → choose the date → there you will find all servers with their owner and email, with a search bar, to **download**, **restore** one, or **restore the whole date** (server files only: the panel database is never touched). The **panel database** backups and the **Paymenter database** backups are each in their own section, with their own **download** and **restore** buttons (to the same VPS or to a new one). While a backup is running you can **cancel it**, and the progress stays visible even if you reload the page. The .zip files exclude `node_modules` and `package-lock.json`.
6. **Administrators.** Create more admins by selecting only the permissions you want to give them.
7. **Logs.** All activity and errors, in real time.

Backups are stored in `storage/backups/` inside the project (servers in `servers/`, panel database in `panel/` with its `.env` copies in `panel/env/`, and Paymenter database in `paymenter/` with its `.env` copies in `paymenter/env/`).

---

## Update the system when there are new changes

When the repository has improvements, update your VPS like this:

```bash
# Enter the project folder
cd /opt/pterodactyl-backup

# Download the changes from GitHub
sudo git pull

# Install new dependencies (if there are any)
sudo npm install

# Restart the system to apply the changes
sudo systemctl restart pterobackups
```

---

## Extension for the Pterodactyl panel (Backup 2.0)

The extension connects your Pterodactyl panel with this backup page:

- **Panel admins:** new **PteroBackups** section in the admin area with everything from the page: make backups instantly, cancel, live progress, next automatic backup counter, backup dates by node, server search by name or email, download, restore, delete, and change the schedule.
- **Users:** **“Backup 2.0”** option in their server sidebar menu to view, **download**, and **restore** ONLY the backups of their server.
- **Compatible with the Arix v2 theme** and any other theme: the extension **does not recompile the panel** (which is what breaks themes), and the menu button copies the design of the active theme.

### Step 1 — Copy the connection details

On **this backup page**, go to **Settings** and find the **“Panel extension”** card. There you will find the two details you need: the **system URL** and the **API key**. Keep them handy (tap them to select and copy them).

### Step 2 — Install the extension on the panel VPS

Connect by SSH **to the VPS where the Pterodactyl panel is installed** (not to the backup system VPS, unless you have both on the same VPS) and run:

```bash
# Enter the /opt folder
cd /opt

# Download the project (if you already have the folder from before, skip this command)
sudo git clone https://github.com/russellxz/pterodactyl-backup.git

# Enter the extension folder
cd pterodactyl-backup/extension

# Install the extension in the panel
sudo bash install.sh
```

The installer copies the pieces to the panel, adds the routes, and clears the caches. At the end, it prints several lines that start with `OK:` and the message “PteroBackups extension installed successfully”.

> If your panel is **not** in the normal folder (`/var/www/pterodactyl`), provide the path: `sudo bash install.sh /path/to/your/panel`

### Step 3 — Connect the panel with the backup system

1. Open `https://YOUR-PANEL/admin/pterobackups` (it also appears as **PteroBackups** in the admin area menu).
2. Paste the **URL** and the **API key** from Step 1.
3. Click **Save and test connection**. It should say **“Connection successful”**.

Reload the panel with `Ctrl + F5`, enter any server, and you will see **“Backup 2.0”** in your server sidebar menu. The connection is saved in the panel database: if one day you reinstall the panel with the same database, just run `install.sh` again and it will reconnect by itself.

### Update the extension when there are changes

```bash
# On the panel VPS: download the changes and reinstall
cd /opt/pterodactyl-backup
sudo git pull
cd extension
sudo bash install.sh
```

### Uninstall or diagnose

```bash
# Remove the extension from the panel (the saved connection is kept)
cd /opt/pterodactyl-backup/extension && sudo bash uninstall.sh

# If something does not appear: print a full diagnostic report
cd /opt/pterodactyl-backup/extension && sudo bash check.sh
```

More details and extension troubleshooting in [`extension/README.md`](extension/README.md).

---

## Troubleshooting

- **The page does not load:** check the system with `sudo systemctl status pterobackups` and watch live errors with `sudo journalctl -u pterobackups -f`. Also check Nginx with `sudo nginx -t`.
- **Cloudflare 521/522 error:** Nginx is off or the firewall is blocking ports 80/443. Check `sudo systemctl status nginx` and step 7.4.
- **`npm install` fails on better-sqlite3:** you are missing `build-essential` and `python3` (Step 1).
- **Test connection fails:** check that you can manually log in with `ssh root@NODE_IP` using that password and that port 22 is not blocked.
- **Backups show “Unknown”:** the panel database details are wrong; check them in “Nodes and Panels” and use **Test connection**.
- **A server is skipped as “empty”:** its volume does not have files yet; this is normal.
- **I changed APP_SECRET and nothing connects:** saved passwords are encrypted with that key; re-enter the node and panel passwords in the web page.

## Security notes

- Use **strong** SSH passwords and, if you can, limit node SSH access by firewall to the IP of this VPS.
- Do not expose port 3500 to the outside: the app only listens on `127.0.0.1` and is served through Nginx with HTTPS.
- This VPS stores credentials (encrypted) for your other VPSs: protect it as well as the panel.

## Roadmap

- [x] Phase 1: backup system web page.
- [x] Phase 2: extension for the Pterodactyl panel (`extension/` folder): full management from the admin area, backups visible/downloadable/restorable by each user in their server, compatible with the Arix v2 theme.

## License

MIT. Use it, modify it, and share it freely.
