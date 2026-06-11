# PteroBackups

Sistema web de copias de seguridad **remotas** para [Pterodactyl](https://pterodactyl.io/). Se instala en un VPS aparte y, conectándose por SSH, hace copias de:

- La **base de datos completa del panel** (mysqldump) + el archivo **`.env`** (imprescindible para reinstalaciones).
- Los **archivos de cada servidor de cada nodo (Wings)**, un `.zip` por servidor, nombrado con el **nombre, apellido y correo del dueño** y el **nombre del servidor**, para encontrarlos al instante con el buscador.

Todo se maneja desde una página web con diseño oscuro, iconos profesionales, progreso en tiempo real y registro de errores.

## Características

- Copias **manuales** (botón "Hacer copia ahora") y **automáticas** (cada 1 hora, 1, 7, 15 o 30 días).
- **Buscador en tiempo real** por nombre, correo o servidor.
- **Descargar** cualquier copia desde la web (servida a través de Nginx).
- **Restaurar** un servidor concreto, **todos los servidores a la vez**, o la **BD del panel** (al mismo VPS o a un VPS nuevo escribiendo su IP y contraseñas).
- **Borrado automático** de copias antiguas (retención configurable) y borrado manual de cualquier copia.
- **Administradores con permisos**: el raíz se crea desde la consola con todos los permisos; desde la web puedes crear más admins eligiendo exactamente qué pueden hacer (descargar, eliminar, restaurar, gestionar nodos...).
- **Progreso en tiempo real** y página de **logs** en vivo (Socket.IO).
- Las contraseñas SSH y de BD se guardan **cifradas** (AES-256) en una base de datos local SQLite.

> La **extensión para el panel de Pterodactyl** (gestionar copias desde el panel, que los usuarios vean/descarguen/restauren las suyas, compatible con el tema Arix v2.0.8) es la **fase 2** de este proyecto y se desarrollará una vez probada la página.

---

## Requisitos

| Dónde | Qué hace falta |
|---|---|
| **VPS del sistema** (donde va esta página) | Ubuntu 22.04 o 24.04, Node.js 18+, Nginx, dominio en Cloudflare |
| **VPS del panel** Pterodactyl | Acceso SSH por contraseña + `zip` y `unzip` instalados |
| **Cada nodo (Wings)** | Acceso SSH por contraseña + `zip` y `unzip` instalados |

No hace falta `sshpass`: el sistema se conecta por SSH directamente desde Node.js.

En el **panel y en cada nodo** ejecuta:

```bash
sudo apt update && sudo apt install -y zip unzip
```

> Importante: el usuario SSH que pongas (normalmente `root`) debe poder entrar **con contraseña**. Si tu VPS solo permite llaves, edita `/etc/ssh/sshd_config`, pon `PasswordAuthentication yes` y `PermitRootLogin yes`, y reinicia SSH con `sudo systemctl restart ssh`.

---

## Instalación (VPS del sistema)

### 1. Instalar Node.js 18, Git y herramientas de compilación

```bash
sudo apt update && sudo apt install -y curl git build-essential python3 nginx
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # debe mostrar v18 o superior
```

### 2. Descargar el proyecto e instalar dependencias

```bash
cd /opt
sudo git clone https://github.com/TU_USUARIO/pterobackups.git
cd pterobackups
sudo npm install
```

(Cambia `TU_USUARIO` por tu usuario de GitHub. Si aún no lo subiste, mira la sección "Subir a GitHub" más abajo.)

### 3. Configurar las variables de entorno

```bash
sudo cp .env.example .env
sudo nano .env
```

Cambia `APP_SECRET` por una clave aleatoria larga. Genera una con:

```bash
openssl rand -hex 32
```

### 4. Crear el primer administrador (raíz)

```bash
sudo npm run create-admin
```

Te pedirá nombre, apellido, correo y contraseña. Los admins creados por consola son **raíz**: tienen todos los permisos y pueden eliminar o cambiar la contraseña de cualquier otro admin. Si algún día pierdes el acceso, vuelve a ejecutar este comando con el mismo correo y se restablecerá la contraseña.

### 5. Dejarlo funcionando como servicio (systemd)

```bash
sudo cp deploy/pterobackups.service /etc/systemd/system/pterobackups.service
sudo systemctl daemon-reload
sudo systemctl enable --now pterobackups
sudo systemctl status pterobackups
```

La app queda escuchando en `127.0.0.1:3500` (solo accesible a través de Nginx).

### 6. Nginx + certificado de origen de Cloudflare

1. En Cloudflare: **SSL/TLS → Servidor de origen → Crear certificado**. Copia el certificado y la clave privada.
2. En el VPS:

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/cert.pem   # pega el CERTIFICADO
sudo nano /etc/ssl/cloudflare/key.pem    # pega la CLAVE PRIVADA
sudo chmod 600 /etc/ssl/cloudflare/key.pem
```

3. Configura el sitio (edita el dominio dentro del archivo):

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pterobackups.conf
sudo nano /etc/nginx/sites-available/pterobackups.conf   # cambia copias.tudominio.com
sudo ln -s /etc/nginx/sites-available/pterobackups.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

4. En Cloudflare: crea un registro **A** con tu subdominio apuntando a la IP del VPS (nube naranja activada) y pon **SSL/TLS** en modo **Full (strict)**.

Listo: entra en `https://copias.tudominio.com` e inicia sesión.

---

## Guía de uso

1. **Nodos y Panel → Panel de Pterodactyl.** Escribe la IP del VPS del panel, su contraseña SSH y los datos de la base de datos. Esos datos están en el archivo `/var/www/pterodactyl/.env` del panel: `DB_USERNAME` (usuario), `DB_PASSWORD` (contraseña) y `DB_DATABASE` (nombre, normalmente `panel`). Pulsa **Probar conexión** para comprobarlo.
2. **Nodos y Panel → Agregar nodo.** Por cada nodo (Wings): un nombre, su IP y su contraseña SSH. Pulsa el botón de probar conexión: te dirá cuántos servidores detecta y si falta instalar `zip`/`unzip`.
3. **Configuración.** Elige cada cuánto se hacen copias automáticas, qué se copia (todo / solo nodos / solo BD) y cuándo se borran las copias antiguas.
4. **Copias.** Botón **Hacer copia ahora** para copias manuales. Desde la tabla puedes **buscar**, **descargar**, **restaurar** (te preguntará si quieres vaciar los archivos actuales antes) y **eliminar**. **Restaurar todo** devuelve la copia más reciente de cada servidor a su nodo. **Restaurar BD del panel** permite elegir el panel guardado u **otro VPS nuevo** (IP + SSH + datos de la BD).
5. **Administradores.** Crea más admins marcando solo los permisos que quieras darles.
6. **Logs.** Toda la actividad y los errores, en tiempo real.

Las copias se guardan en `storage/backups/` (servidores en `servers/`, BD en `panel/` y una copia suelta de cada `.env` en `panel/env/`).

---

## Subir a GitHub (primera vez)

Crea un repositorio vacío en GitHub y, desde la carpeta del proyecto en tu PC o VPS:

```bash
git init
git add .
git commit -m "Primera versión de PteroBackups"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/pterobackups.git
git push -u origin main
```

> El archivo `.gitignore` ya evita que se suban `.env`, la base de datos local y las copias (datos sensibles).

### Subir cambios (push)

Cada vez que modifiques algo:

```bash
git add .
git commit -m "Describe aquí tu cambio"
git push
```

### Actualizar el VPS con los cambios de GitHub (pull)

```bash
cd /opt/pterobackups
sudo git pull
sudo npm install
sudo systemctl restart pterobackups
```

---

## Solución de problemas

- **No carga la página:** `sudo systemctl status pterobackups` y `sudo journalctl -u pterobackups -f` para ver el error. Revisa también `sudo nginx -t`.
- **"npm install" falla en better-sqlite3:** te falta `build-essential` y `python3` (paso 1).
- **Probar conexión falla:** comprueba que puedes entrar a mano con `ssh root@IP_DEL_NODO` usando esa contraseña, y que el puerto 22 no está bloqueado por firewall.
- **Las copias salen con "Desconocido":** la conexión a la BD del panel falló; revisa usuario/contraseña/nombre de la BD en "Nodos y Panel" y usa **Probar conexión**.
- **Un servidor se omite por "vacío":** su volumen no tiene archivos; es normal en servidores recién creados.
- **Cambié APP_SECRET y ya nada conecta:** las contraseñas guardadas se cifran con esa clave; vuelve a escribir las contraseñas de los nodos y del panel.

## Notas de seguridad

- Usa contraseñas SSH **fuertes** y, si puedes, limita el acceso SSH de los nodos por firewall a la IP de este VPS.
- No expongas el puerto 3500: la app escucha solo en `127.0.0.1` y se sirve por Nginx con HTTPS.
- Este VPS guarda credenciales (cifradas) de tus otros VPS: protégelo igual de bien que al panel.

## Hoja de ruta

- [x] Fase 1: página web del sistema de copias (este repositorio).
- [ ] Fase 2: extensión para el panel de Pterodactyl (gestión desde el área admin, copias visibles para cada usuario, compatible con el tema Arix v2.0.8).

## Licencia

MIT. Úsalo, modifícalo y compártelo libremente.
