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

# Revertir el ajuste de la ruta comodín de React
sed -i 's#api|auth|admin|daemon|pterobackups#api|auth|admin|daemon#g' "$PANEL/routes/base.php" 2>/dev/null || true

# Quitar rutas
sed -i '/PteroBackups START/,/PteroBackups END/d' "$PANEL/routes/base.php" 2>/dev/null || true
sed -i '/PteroBackups START/,/PteroBackups END/d' "$PANEL/routes/admin.php" 2>/dev/null || true

# Quitar scripts inyectados (de cualquier plantilla donde estén)
for FILE in $(grep -rl 'pterobackups/inject.js\|pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null | grep -v 'views/pterobackups\|views/admin/pterobackups'); do
  sed -i '\#pterobackups/inject.js#d' "$FILE" 2>/dev/null || true
  sed -i '\#pterobackups/admin-inject.js#d' "$FILE" 2>/dev/null || true
done
sed -i "\\#pterobackups/inject.js#d" "$PANEL/resources/views/layouts/scripts.blade.php" 2>/dev/null || true

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
