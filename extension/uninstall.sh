#!/bin/bash
# Desinstalador de la extensión PteroBackups.
# Uso:   sudo bash uninstall.sh [/ruta/del/panel]
set -e

PANEL="${1:-/var/www/pterodactyl}"

if [ ! -f "$PANEL/artisan" ]; then
  echo "ERROR: No se encontró el panel de Pterodactyl en: $PANEL"
  exit 1
fi

echo "==> Desinstalando la extensión PteroBackups de: $PANEL"

# Quitar rutas
sed -i '/PteroBackups START/,/PteroBackups END/d' "$PANEL/routes/base.php" 2>/dev/null || true
sed -i '/PteroBackups START/,/PteroBackups END/d' "$PANEL/routes/admin.php" 2>/dev/null || true

# Quitar scripts inyectados
sed -i '\#pterobackups/inject.js#d' "$PANEL/resources/views/templates/wrapper.blade.php" 2>/dev/null || true
sed -i '\#pterobackups/admin-inject.js#d' "$PANEL/resources/views/layouts/admin.blade.php" 2>/dev/null || true

# Quitar archivos
rm -rf "$PANEL/app/Http/Controllers/PteroBackups" \
       "$PANEL/app/PteroBackups" \
       "$PANEL/resources/views/admin/pterobackups" \
       "$PANEL/resources/views/pterobackups" \
       "$PANEL/public/pterobackups"

cd "$PANEL"
php artisan view:clear  >/dev/null 2>&1 || true
php artisan route:clear >/dev/null 2>&1 || true

echo "==> Extensión desinstalada."
echo "    (La URL y la clave guardadas en la BD del panel se conservan por si reinstalas.)"
