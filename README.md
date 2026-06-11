# PteroBackups

Sistema web de copias de seguridad **remotas** para [Pterodactyl](https://pterodactyl.io/). Se instala en un VPS aparte y, conectándose por SSH, hace copias de:

- La **base de datos completa del panel** (mysqldump) + el archivo **`.env`** (imprescindible para reinstalaciones).
- Los **archivos de cada servidor de cada nodo (Wings)**, un `.zip` por servidor, nombrado con el **nombre, apellido y correo del dueño** y el **nombre del servidor**, para encontrarlos al instante con el buscador.

Todo se maneja desde una página web con diseño oscuro, iconos profesionales, progreso en tiempo real y registro de errores.

## Características

- Copias **manuales** (botón "Hacer copia ahora") y **automáticas** (cada 1 hora, 1, 7, 15 o 30 días).
- **Buscador en tiempo real** por nombre, correo o servidor.
- **Descargar** cualquier copia desde la web.
- **Restaurar** un servidor concreto, **todos a la vez**, o la **BD del panel** (al mismo VPS o a uno nuevo).
- **Borrado automático** de copias antiguas (retención configurable).
- **Administradores con permisos** personalizables.
- **Progreso en tiempo real** y página de **logs** en vivo.
- Contraseñas SSH y de BD guardadas **cifradas** (AES-256) en una base de datos local SQLite (no hay que instalar ninguna base de datos: se crea sola en un archivo).

> La **extensión para el panel de Pterodactyl** (compatible con el tema Arix v2.0.8) es la **fase 2** y se desarrollará una vez probada la página.

---

## Antes de empezar: 2 cosas básicas

**¿Qué es `sudo`?** Significa "ejecutar como administrador". Si ya estás conectado como `root`, los comandos funcionan igual con o sin `sudo`.

**¿Qué es `nano`?** Es el editor de texto de la terminal. Lo usarás varias veces. Así se maneja:

| Acción | Tecla |
|---|---|
| Moverte por el texto | Flechas del teclado |
| Pegar texto copiado | Clic derecho (o `Ctrl + Shift + V`) |
| **Guardar** | `Ctrl + O` y luego `Enter` |
| **Salir** | `Ctrl + X` |

---

## Requisitos

| Dónde | Qué hace falta |
|---|---|
| **VPS del sistema** (donde instalas esta página) | Ubuntu 22.04 o 24.04 limpio y un dominio agregado a Cloudflare |
| **VPS del panel** Pterodactyl | Acceso SSH con contraseña + `zip` y `unzip` |
| **Cada nodo (Wings)** | Acceso SSH con contraseña + `zip` y `unzip` |

En el **VPS del panel** y en **cada nodo** ejecuta esto (instala las herramientas para comprimir y descomprimir las copias):

```bash
sudo apt update && sudo apt install -y zip unzip
```

> **Importante:** el usuario SSH que uses (normalmente `root`) debe poder entrar **con contraseña**. Si tu VPS solo acepta llaves, abre la configuración con `sudo nano /etc/ssh/sshd_config`, busca y deja así estas líneas: `PasswordAuthentication yes` y `PermitRootLogin yes`. Guarda, sal y reinicia SSH con `sudo systemctl restart ssh`.

---

## Instalación paso a paso (VPS del sistema)

### Paso 1 — Instalar Node.js 22, Git y Nginx

```bash
# Actualiza la lista de programas disponibles
sudo apt update

# Instala: curl (descargar cosas), git (clonar el proyecto),
# build-essential y python3 (necesarios para compilar la base de datos),
# y nginx (el servidor web que mostrará la página)
sudo apt install -y curl git build-essential python3 nginx

# Agrega el repositorio oficial de Node.js 22 (versión LTS con soporte hasta 2027)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

# Instala Node.js
sudo apt install -y nodejs

# Comprueba que se instaló bien: debe mostrar v22.x
node -v
```

> **¿Ya habías instalado Node 18?** Ejecuta igualmente los dos primeros comandos (lo reemplazan por el 22) y, si ya habías hecho `npm install` en el proyecto, recompila las dependencias con: `cd /opt/pterodactyl-backup && sudo npm rebuild`

### Paso 2 — Descargar el proyecto

```bash
# Entra a la carpeta /opt (donde se suelen instalar programas)
cd /opt

# Descarga el proyecto desde GitHub
sudo git clone https://github.com/russellxz/pterodactyl-backup.git

# Entra a la carpeta del proyecto
cd pterodactyl-backup

# Instala las dependencias del proyecto (tarda 1-3 minutos)
sudo npm install
```

### Paso 3 — Configurar el archivo .env (la clave secreta)

El archivo `.env` guarda la configuración privada del sistema. Lo más importante es `APP_SECRET`: una clave que protege las sesiones de login y **cifra las contraseñas SSH** que guardes. Cada instalación debe tener la suya.

```bash
# Crea tu configuración a partir de la plantilla de ejemplo
sudo cp .env.example .env

# Genera una clave aleatoria segura. COPIA el resultado que aparece
openssl rand -hex 32

# Abre la configuración para editarla
sudo nano .env
```

Dentro de nano, busca la línea que empieza con `APP_SECRET=` y borra lo que hay después del `=` y pega tu clave. Debe quedar algo así:

```
APP_SECRET=f3a91c0d8b27e6...tu_clave_larga...
```

Guarda con `Ctrl + O`, `Enter`, y sal con `Ctrl + X`. El resto del archivo no hace falta tocarlo.

### Paso 4 — Crear tu cuenta de administrador

```bash
sudo npm run create-admin
```

Te preguntará nombre, apellido, correo y contraseña (mínimo 8 caracteres). Con esa cuenta entrarás a la página. Los admins creados por consola son **raíz**: tienen todos los permisos. Si algún día olvidas la contraseña, vuelve a ejecutar este mismo comando con el mismo correo y quedará restablecida.

### Paso 5 — Dejar el sistema encendido siempre (systemd)

Esto hace que la página arranque sola al encender el VPS y se reinicie si falla. El servicio ya viene configurado para la instalación por defecto (`/opt/pterodactyl-backup`), no hay que editar nada.

```bash
# Copia el archivo del servicio al sistema
sudo cp deploy/pterobackups.service /etc/systemd/system/pterobackups.service
```

> Solo si clonaste el proyecto en OTRA carpeta distinta: ábrelo con `sudo nano /etc/systemd/system/pterobackups.service` y cambia la línea `WorkingDirectory=` por tu ruta real.

Ahora activa el servicio:

```bash
# Recarga systemd para que detecte el servicio nuevo
sudo systemctl daemon-reload

# Activa el arranque automático y enciende el sistema ahora
sudo systemctl enable --now pterobackups

# Comprueba que está corriendo: debe decir "active (running)" en verde
sudo systemctl status pterobackups
```

La app queda escuchando solo internamente en `127.0.0.1:3500`. Nadie puede entrar todavía desde fuera: para eso es Nginx (siguiente paso).

---

## Paso 6 — Dominio en Cloudflare

Necesitas un subdominio para tu página, por ejemplo `copias.tudominio.com`.

1. Entra a [Cloudflare](https://dash.cloudflare.com) y elige tu dominio.
2. Ve a **DNS → Records → Add record** y crea:
   - **Type:** `A`
   - **Name:** `copias` (o el nombre que quieras)
   - **IPv4 address:** la IP de este VPS (el del sistema de copias)
   - **Proxy status:** activado (nube naranja)
3. Ve a **SSL/TLS → Overview** y pon el modo en **Full (strict)**.
4. Ve a **SSL/TLS → Origin Server → Create Certificate**:
   - Deja las opciones por defecto y pulsa **Create**.
   - Te mostrará dos cuadros de texto: el **Origin Certificate** (certificado) y la **Private Key** (clave privada). **Deja esa pestaña abierta**, los vas a copiar en el siguiente paso.

## Paso 7 — Configurar Nginx con el certificado

Nginx es la "puerta de entrada": recibe las visitas a `https://copias.tudominio.com` con el certificado de Cloudflare y las pasa internamente a la app.

**7.1 — Guardar el certificado de Cloudflare en el VPS:**

```bash
# Crea la carpeta donde vivirán el certificado y la clave
sudo mkdir -p /etc/ssl/cloudflare

# Abre un archivo vacío para el CERTIFICADO
sudo nano /etc/ssl/cloudflare/cert.pem
```

Pega el **Origin Certificate** completo de Cloudflare (desde `-----BEGIN CERTIFICATE-----` hasta `-----END CERTIFICATE-----`). Guarda y sal.

```bash
# Abre un archivo vacío para la CLAVE PRIVADA
sudo nano /etc/ssl/cloudflare/key.pem
```

Pega la **Private Key** completa (desde `-----BEGIN PRIVATE KEY-----` hasta `-----END PRIVATE KEY-----`). Guarda y sal.

```bash
# Protege la clave privada para que solo root pueda leerla
sudo chmod 600 /etc/ssl/cloudflare/key.pem
```

**7.2 — Poner TU dominio en la configuración de Nginx:**

```bash
# Copia la configuración incluida en el proyecto
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pterobackups.conf

# Ábrela para poner tu dominio
sudo nano /etc/nginx/sites-available/pterobackups.conf
```

Dentro verás **dos** líneas que dicen:

```
server_name copias.tudominio.com;
```

Cambia `copias.tudominio.com` por tu subdominio real **en las dos líneas** (una está en el bloque del puerto 80 y otra en el del 443). No toques nada más. Guarda y sal.

**7.3 — Activar el sitio:**

```bash
# Activa la configuración (crea un "acceso directo" en sites-enabled)
sudo ln -s /etc/nginx/sites-available/pterobackups.conf /etc/nginx/sites-enabled/

# Comprueba que no hay errores de escritura: debe decir "syntax is ok" y "test is successful"
sudo nginx -t

# Aplica los cambios
sudo systemctl reload nginx
```

**7.4 — (Solo si usas firewall UFW) abrir los puertos web:**

```bash
sudo ufw allow 'Nginx Full'
```

**Listo.** Abre `https://copias.tudominio.com` en tu navegador e inicia sesión con la cuenta del Paso 4.

---

## Guía de uso de la página

1. **Nodos y Panel → Panel de Pterodactyl.** Escribe la IP del VPS del panel, su contraseña SSH y los datos de la base de datos. Esos datos están en el archivo `/var/www/pterodactyl/.env` **del panel**: `DB_USERNAME` (usuario), `DB_PASSWORD` (contraseña) y `DB_DATABASE` (nombre, normalmente `panel`). Puedes verlos con `cat /var/www/pterodactyl/.env` en el VPS del panel. Pulsa **Probar conexión**.
2. **Nodos y Panel → Agregar nodo.** Por cada nodo (Wings): un nombre, su IP y su contraseña SSH. El botón de probar conexión te dirá cuántos servidores detecta y si falta instalar `zip`/`unzip`.
3. **Configuración.** Elige cada cuánto se hacen las copias automáticas, qué se copia y cuándo se borran las copias antiguas.
4. **Copias.** Botón **Hacer copia ahora** para copias manuales. En la tabla puedes **buscar**, **descargar**, **restaurar** y **eliminar**. **Restaurar todo** devuelve la copia más reciente de cada servidor a su nodo. **Restaurar BD del panel** permite elegir el panel guardado u otro VPS nuevo.
5. **Administradores.** Crea más admins marcando solo los permisos que quieras darles.
6. **Logs.** Toda la actividad y los errores, en tiempo real.

Las copias se guardan en `storage/backups/` dentro del proyecto (servidores en `servers/`, BD en `panel/` y las copias del `.env` en `panel/env/`).

---

## Actualizar el sistema cuando haya cambios nuevos

Cuando el repositorio tenga mejoras, actualiza tu VPS así:

```bash
# Entra a la carpeta del proyecto
cd /opt/pterodactyl-backup

# Descarga los cambios desde GitHub
sudo git pull

# Instala dependencias nuevas (si las hay)
sudo npm install

# Reinicia el sistema para aplicar los cambios
sudo systemctl restart pterobackups
```

## Para desarrolladores: subir cambios a GitHub (push)

Si modificaste el código y quieres subirlo al repositorio:

```bash
# Marca todos los archivos modificados
git add .

# Guarda los cambios con una descripción
git commit -m "Describe aquí qué cambiaste"

# Súbelos a GitHub
git push
```

> El `.gitignore` ya evita que se suban `.env`, la base de datos local (`data/`) y las copias (`storage/`): son datos privados de cada instalación.

---

## Solución de problemas

- **La página no carga:** revisa el sistema con `sudo systemctl status pterobackups` y mira los errores en vivo con `sudo journalctl -u pterobackups -f`. Revisa también Nginx con `sudo nginx -t`.
- **Error 521/522 de Cloudflare:** Nginx está apagado o el firewall bloquea los puertos 80/443. Revisa `sudo systemctl status nginx` y el paso 7.4.
- **`npm install` falla en better-sqlite3:** te faltó `build-essential` y `python3` (Paso 1).
- **Probar conexión falla:** comprueba que puedes entrar a mano con `ssh root@IP_DEL_NODO` usando esa contraseña y que el puerto 22 no está bloqueado.
- **Las copias salen con "Desconocido":** los datos de la BD del panel están mal; revísalos en "Nodos y Panel" y usa **Probar conexión**.
- **Un servidor se omite por "vacío":** su volumen no tiene archivos todavía; es normal.
- **Cambié APP_SECRET y nada conecta:** las contraseñas guardadas se cifran con esa clave; vuelve a escribir las contraseñas de los nodos y del panel en la web.

## Notas de seguridad

- Usa contraseñas SSH **fuertes** y, si puedes, limita el SSH de los nodos por firewall a la IP de este VPS.
- No abras el puerto 3500 al exterior: la app solo escucha en `127.0.0.1` y se sirve por Nginx con HTTPS.
- Este VPS guarda credenciales (cifradas) de tus otros VPS: protégelo igual de bien que al panel.

## Hoja de ruta

- [x] Fase 1: página web del sistema de copias (este repositorio).
- [ ] Fase 2: extensión para el panel de Pterodactyl (gestión desde el área admin, copias visibles para cada usuario, compatible con el tema Arix v2.0.8).

## Licencia

MIT. Úsalo, modifícalo y compártelo libremente.
