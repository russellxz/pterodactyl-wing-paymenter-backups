# Extensión PteroBackups para el panel de Pterodactyl

Conecta tu panel de Pterodactyl con el sistema de copias **PteroBackups**:

- **Admins (raíz):** nueva sección **PteroBackups** en el área admin con TODO lo de la página: hacer copias manuales, cancelar, ver el progreso en tiempo real, contador de la próxima copia automática, ver las fechas de copia de cada nodo, buscar el servidor de un usuario, descargar, restaurar (un servidor o una fecha completa), eliminar y cambiar la programación.
- **Usuarios:** nueva opción **"Backup 2.0"** en el menú lateral de su servidor (junto a Consola, Archivos...). Cada usuario ve SOLO las copias de su servidor, las puede **descargar** y **restaurar**. Si no hay copias, lo verá indicado.

## Cómo se añaden los botones

Los dos botones se registran de forma **nativa**, igual que cualquier modificación seria del panel:

| Dónde | Cómo | ¿Hay que recompilar? |
| --- | --- | --- |
| Menú del servidor (usuarios) | una entrada en `resources/scripts/routers/routes.ts` | **Sí** (`yarn build:production`, lo hace el instalador) |
| Menú del área admin | un `<li>` en `resources/views/layouts/admin.blade.php` | No (esa parte del panel es Blade) |

Antes el botón se metía con un script que escaneaba la página constantemente buscando dónde colgarse. Eso disparaba la CPU del navegador —sobre todo en móvil en "modo escritorio"— y hacía que **Cloudflare tomara al usuario por un bot y le mostrara su pantalla de comprobación**. Con el método nativo no se ejecuta ni una línea de JavaScript extra: el menú lo dibuja el propio panel.

### Si usas un tema como Arix

Recompilar el panel **sobrescribe los cambios del tema en el frontend**, así que el orden importa: instala primero tu tema y **después** esta extensión (o vuelve a aplicar el tema y ejecuta `sudo bash install.sh` otra vez).

Si prefieres no recompilar ahora, usa `sudo bash install.sh --no-build`: el área de admin queda funcionando al instante y el botón del menú de los usuarios aparecerá cuando ejecutes `cd /var/www/pterodactyl && yarn build:production`. Mientras tanto, la página sigue siendo accesible en `https://TU-PANEL/pterobackups/server/<id-del-servidor>`.

## Requisitos

- Panel de Pterodactyl 1.x funcionando (probado con 1.11).
- El sistema PteroBackups instalado y accesible por HTTPS (este mismo repositorio).

## Instalación (en el VPS donde está el PANEL)

```bash
# 1. Descarga el proyecto en el VPS del panel (si no lo tienes ya)
cd /opt
sudo git clone https://github.com/russellxz/pterodactyl-backup.git

# 2. Ejecuta el instalador de la extensión
cd /opt/pterodactyl-backup/extension
sudo bash install.sh
```

> Si tu panel NO está en `/var/www/pterodactyl`, pásale la ruta: `sudo bash install.sh /ruta/de/tu/panel`

## Conectar con el sistema de copias

1. En tu **sistema de copias**, entra a **Configuración → Extensión del panel** y copia la **URL** y la **clave de API**.
2. En tu **panel**, entra a `https://TU-PANEL/admin/pterobackups` (también aparece **PteroBackups** en el menú del admin).
3. Pega la URL y la clave → **Guardar y probar conexión**. Si dice "Conexión correcta", listo.

La conexión se guarda en la **base de datos del panel**: si algún día reinstalas el panel con la misma BD, solo vuelve a ejecutar `install.sh` y la extensión reconecta sola con tu clave guardada.

## Actualizar la extensión

```bash
cd /opt/pterodactyl-backup
sudo git pull
cd extension
sudo bash install.sh
```

## Desinstalar

```bash
cd /opt/pterodactyl-backup/extension
sudo bash uninstall.sh
```

## Solución de problemas

- **No aparece "Backup 2.0" en el menú del servidor:** recarga con `Ctrl + F5` (caché del navegador). Comprueba que el script quedó inyectado: `grep pterobackups /var/www/pterodactyl/resources/views/templates/wrapper.blade.php` y limpia vistas: `cd /var/www/pterodactyl && php artisan view:clear`.
- **/admin/pterobackups da 404:** limpia las rutas: `cd /var/www/pterodactyl && php artisan route:clear`.
- **Error 500:** mira el log del panel: `tail -50 /var/www/pterodactyl/storage/logs/laravel-$(date +%F).log` y ejecuta `cd /var/www/pterodactyl && COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload -o`.
- **"No se pudo conectar" al guardar:** comprueba que la URL del sistema abre en el navegador y que la clave es la de **Configuración → Extensión del panel** (sin espacios). Si regeneraste la clave en el sistema, pégala de nuevo aquí.
- **Los usuarios ven la página pero sin copias:** es normal si su servidor aún no tiene copias; se crean con la programación o con copias manuales.
- **No sale "Backup 2.0" en el menú del servidor:** falta recompilar. Ejecuta `cd /var/www/pterodactyl && yarn build:production` y recarga con Ctrl+F5. `check.sh` te lo dice.

## Notas

- Solo el **dueño** del servidor (o un admin) puede ver y restaurar las copias de ese servidor; el sistema rechaza cualquier intento de tocar copias de otros servidores.
- Las descargas pasan por el panel (streaming), así que la clave de API nunca llega al navegador del usuario.
- La entrada del menú usa el permiso `backup.*`, así que un subusuario sin ese permiso no la ve. Aun así el acceso real lo decide el servidor: solo el dueño (o un admin) puede listar y restaurar.

## Importante si reinstalas o actualizas tu tema

Un tema que toque el frontend (como Arix) reemplaza archivos de `resources/scripts` y recompila el panel, y eso se lleva por delante la entrada del menú de los usuarios. **Después de instalar o actualizar el tema, vuelve a ejecutar `sudo bash install.sh`.** El botón del área de admin no se ve afectado, porque no depende de la compilación.

## Diagnóstico

```bash
cd /opt/pterodactyl-backup/extension
sudo bash check.sh
```

Dice si los botones están registrados, si el panel se recompiló **después** de registrarlos (que es lo que hace falta para que el de usuario aparezca) y si quedan restos de la versión antigua.
