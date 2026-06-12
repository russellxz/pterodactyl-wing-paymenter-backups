# Extensión PteroBackups para el panel de Pterodactyl

Conecta tu panel de Pterodactyl con el sistema de copias **PteroBackups**:

- **Admins (raíz):** nueva sección **PteroBackups** en el área admin con TODO lo de la página: hacer copias manuales, cancelar, ver el progreso en tiempo real, contador de la próxima copia automática, ver las fechas de copia de cada nodo, buscar el servidor de un usuario, descargar, restaurar (un servidor o una fecha completa), eliminar y cambiar la programación.
- **Usuarios:** nueva opción **"Backup 2.0"** en el menú lateral de su servidor (junto a Consola, Archivos...). Cada usuario ve SOLO las copias de su servidor, las puede **descargar** y **restaurar**. Si no hay copias, lo verá indicado.

## Compatible con el tema Arix v2 (y cualquier otro tema)

Esta extensión **no recompila el panel** (no usa `yarn`/`npm`), que es lo que rompe los temas como Arix. El botón del menú se añade con un script que **clona el botón "Files" del tema activo**, así adopta automáticamente el diseño de Arix o del panel normal. Puedes instalar o desinstalar la extensión sin tocar tu tema.

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

## Notas

- Solo el **dueño** del servidor (o un admin) puede ver y restaurar las copias de ese servidor; el sistema rechaza cualquier intento de tocar copias de otros servidores.
- Las descargas pasan por el panel (streaming), así que la clave de API nunca llega al navegador del usuario.

## Importante si usas el tema Arix

Arix reemplaza el archivo `wrapper.blade.php` del panel cuando se instala o se actualiza, y eso borra el script del botón. **Después de instalar o actualizar Arix, vuelve a ejecutar `sudo bash install.sh`** (tarda segundos y no daña nada). Además, si el tema redibuja el menú y no deja poner el botón, la extensión muestra un **botón flotante "Backup 2.0"** abajo a la derecha en las páginas del servidor, para que los usuarios siempre tengan acceso.
