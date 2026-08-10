# Extensión PteroBackups para el panel de Pterodactyl

Conecta tu panel de Pterodactyl con el sistema de copias **PteroBackups**:

- **Admins (raíz):** nueva sección **PteroBackups** en el área admin con TODO lo de la página: hacer copias manuales, cancelar, ver el progreso en tiempo real, contador de la próxima copia automática, ver las fechas de copia de cada nodo, buscar el servidor de un usuario, descargar, restaurar (un servidor o una fecha completa), eliminar y cambiar la programación.
- **Usuarios:** nueva opción **"Backup 2.0"** en el menú lateral de su servidor (junto a Consola, Archivos...). Cada usuario ve SOLO las copias de su servidor, las puede **descargar** y **restaurar**. Si no hay copias, lo verá indicado.

---

## Comandos

Todo se hace desde la carpeta `extension/`, en el VPS **del panel**.

### Instalar (o actualizar)

```bash
cd /opt/pterodactyl-wing-paymenter-backups/extension && sudo bash install.sh
```

### Desinstalar

```bash
cd /opt/pterodactyl-wing-paymenter-backups/extension && sudo bash uninstall.sh
```

### Comprobar por qué no sale el botón

```bash
cd /opt/pterodactyl-wing-paymenter-backups/extension && sudo bash check.sh
```

> Si tu panel **no** está en `/var/www/pterodactyl`, pásale la ruta a cualquiera de los tres:
> `sudo bash install.sh /ruta/de/tu/panel`

La primera vez, para bajarte el proyecto al VPS del panel:

```bash
cd /opt
sudo git clone https://github.com/russellxz/pterodactyl-wing-paymenter-backups.git
cd pterodactyl-wing-paymenter-backups/extension
sudo bash install.sh
```

Y para actualizar más adelante:

```bash
cd /opt/pterodactyl-wing-paymenter-backups && sudo git pull
cd extension && sudo bash install.sh
```

Instalar y desinstalar se pueden repetir las veces que haga falta: no duplican botones ni dejan restos.

---

## Cómo se añaden los botones

Los dos botones se registran de forma **nativa**. **No se inyecta nada**: no hay ni un JavaScript extra corriendo en el navegador de tus clientes.

Antes el botón se metía con un script que escaneaba la página constantemente buscando dónde colgarse. Eso disparaba la CPU del navegador —sobre todo en móvil en "modo escritorio"— y hacía que **Cloudflare tomara al usuario por un bot y le mostrara su pantalla de comprobación**.

El instalador mira primero si tu tema trae **hueco para extensiones** y elige el método solo:

| Tu tema | Botón del cliente | Botón del admin | ¿Recompilar? |
| --- | --- | --- | --- |
| **Con hueco** (Arix preparado) | una carpeta en `resources/scripts/components/server/extensions/pterobackups/` | un archivo en `resources/views/admin/extensions/pterobackups.blade.php` | Sí, para el del cliente |
| **Sin hueco** (panel normal) | una entrada en `resources/scripts/routers/routes.ts` | un `<li>` en `resources/views/layouts/admin.blade.php` | Sí, para el del cliente |

**El hueco es el método bueno**: la extensión deja su carpeta y el tema la recoge sola al compilar. No se toca ni un archivo del panel ni del tema, así que actualizar el tema no rompe la extensión y desinstalar es borrar una carpeta.

El botón del admin **nunca** necesita recompilar: esa parte del panel es Blade (HTML del servidor).

### Tema Arix

Si tu Arix **trae el hueco**, no hay que hacer nada más: el botón sale del hueco.

Si es un Arix **sin hueco**, su menú del servidor no sale de `routes.ts` sino de una lista de enlaces guardada en la base de datos (la misma que editas en `/admin/arix` → Links). El instalador añade ahí la entrada solo. A mano:

```bash
cd /var/www/pterodactyl && php artisan pterobackups:arix-link            # poner
cd /var/www/pterodactyl && php artisan pterobackups:arix-link --remove   # quitar
cd /var/www/pterodactyl && php artisan pterobackups:arix-link --status   # ver si está
```

El comando es idempotente, respeta el resto de tu menú y coloca el botón detrás del de "Backups".

> Si Arix todavía no ha guardado su configuración de enlaces, el comando te lo dirá: entra una vez a `/admin/arix` → Links, pulsa Guardar y vuelve a ejecutarlo.

**Orden de instalación: primero el tema, después la extensión.** Instalar el tema recompila el panel y puede llevarse por delante el botón del cliente. Si te pasa, se arregla volviendo a ejecutar `sudo bash install.sh`.

---

## Red de seguridad al compilar

`yarn build:production` ejecuta antes `yarn run clean`, que **borra `public/assets/*.js`**. Si el build falla después, el panel se queda sin frontend: pantalla en blanco. Por eso ni el instalador ni el desinstalador compilan sin red:

1. **Copian `public/assets`** antes de tocar nada (en `storage/pterobackups-assets-<fecha>`).
2. **Ajustan la memoria de node** al 75% de la libre y, si hay menos de 2 GB sin swap, crean una swap temporal de 4 GB que se quita sola al terminar. Solo descargan dependencias si faltan, usan `npm` si no hay `yarn`, y activan `--openssl-legacy-provider` únicamente si el panel trae webpack 4.
3. Compilan guardando la salida en `storage/logs/pterobackups-build-<fecha>.log`.
4. **Comprueban que el bundle existe de verdad**, porque un build puede salir con código 0 y no generar nada.
5. Si algo falla: **devuelven los assets tal cual estaban**. El panel sigue funcionando y el área de admin queda instalada igual.

Cuando el build sale bien, el instalador se queda solo con las **3 copias más recientes** y borra las viejas, para no ir llenando el disco a cada instalación. El desinstalador las borra todas.

Además te dicen la causa en lenguaje claro: si fue falta de memoria, te dan el comando exacto para añadir swap; si fueron errores de compilación, te enseñan los bloques `ERROR in` con contexto; y si no, las últimas líneas útiles del registro.

Al terminar, el instalador **comprueba que el botón está de verdad dentro del frontend compilado** y te lo dice. Si no llegó, te dice por qué y con qué comando terminarlo — ya no dice "instalada correctamente" cuando el botón no ha llegado.

### Si prefieres no recompilar ahora

Añade `--no-build` a `install.sh` o a `uninstall.sh`. El área de admin queda lista al instante; el botón del cliente aparece (o desaparece) cuando ejecutes:

```bash
cd /var/www/pterodactyl && yarn build:production
```

---

## Conectar con el sistema de copias

1. En tu **sistema de copias**, entra a **Configuración → Extensión del panel** y copia la **URL** y la **clave de API**.
2. En tu **panel**, entra a `https://TU-PANEL/admin/pterobackups` (también aparece **PteroBackups** en el menú del admin).
3. Pega la URL y la clave → **Guardar y probar conexión**. Si dice "Conexión correcta", listo.

La conexión se guarda en la **base de datos del panel**. El desinstalador **no** la borra: si reinstalas, la extensión reconecta sola con tu clave guardada.

---

## Qué hace exactamente el desinstalador

Un solo comando quita **todas las versiones**: la del hueco del tema, la de `routes.ts` y la antigua de los `inject.js`. Es seguro ejecutarlo aunque no sepas cuál tienes, y se puede repetir.

- Borra la carpeta del hueco del cliente y el archivo del hueco del admin.
- Deja `routes.ts` **byte a byte** como estaba (restaura la copia del original que guardó al instalar).
- Quita el `<li>` de la plantilla del admin y el enlace de la lista de Arix.
- Revierte la ruta comodín de React y quita las rutas de `base.php` y `admin.php`.
- Limpia las plantillas donde hubiera scripts inyectados y borra los archivos de la extensión.
- **Recompila el panel**, que es lo que de verdad hace desaparecer el botón del cliente. Mientras no se recompile, el botón sigue dentro del frontend ya compilado aunque los archivos se hayan borrado. Si la recompilación fallara, devuelve el frontend anterior tal cual.

El archivo del hueco del admin se borra **siempre**, aunque tu panel no tenga la plantilla de admin normal: ese archivo llama a `route('admin.pterobackups')` y, sin la extensión, esa ruta no existe. Si se quedara, el área de administración entera daría error 500.

---

## Requisitos

- Panel de Pterodactyl 1.x funcionando (probado con 1.11 y 1.15).
- El sistema PteroBackups instalado y accesible por HTTPS (este mismo repositorio).

---

## Solución de problemas

Lo primero, siempre:

```bash
cd /opt/pterodactyl-wing-paymenter-backups/extension && sudo bash check.sh
```

Te dice, punto por punto, si el archivo del botón está puesto, si el botón está **dentro del frontend compilado** (que es lo que decide si se ve), si las rutas están y si quedan restos de la versión antigua.

- **No aparece "Backup 2.0" en el menú del servidor:** recarga con `Ctrl + F5` (caché del navegador). Si sigue sin salir, `check.sh` te dirá si falta compilar: `cd /var/www/pterodactyl && yarn build:production`.
- **Sale "Backup 2.0" dos veces:** está puesto en el hueco del tema *y* en la lista de enlaces de Arix. Quita el de la lista: `php artisan pterobackups:arix-link --remove`. `check.sh` lo avisa.
- **/admin/pterobackups da 404:** limpia las rutas: `cd /var/www/pterodactyl && php artisan route:clear`.
- **Error 500:** mira el log del panel: `tail -50 /var/www/pterodactyl/storage/logs/laravel-$(date +%F).log` y ejecuta `cd /var/www/pterodactyl && COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload -o`.
- **"No se pudo conectar" al guardar:** comprueba que la URL del sistema abre en el navegador y que la clave es la de **Configuración → Extensión del panel** (sin espacios). Si regeneraste la clave en el sistema, pégala de nuevo aquí.
- **Los usuarios ven la página pero sin copias:** es normal si su servidor aún no tiene copias; se crean con la programación o con copias manuales.
- **El instalador se para con un error:** te dice la línea exacta y el código. **No desinstala nada**: lo que ya funcionaba se queda funcionando. Manda esas líneas.

---

## Notas

- Solo el **dueño** del servidor (o un admin) puede ver y restaurar las copias de ese servidor; el sistema rechaza cualquier intento de tocar copias de otros servidores.
- Las descargas pasan por el panel (streaming), así que la clave de API nunca llega al navegador del usuario.
- La entrada del menú usa el permiso `backup.*`, así que un subusuario sin ese permiso no la ve. Aun así el acceso real lo decide el servidor: solo el dueño (o un admin) puede listar y restaurar.
