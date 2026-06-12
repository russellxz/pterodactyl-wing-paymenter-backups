#!/bin/bash
# ============================================================================
# Instalador de la extensión PteroBackups para el panel de Pterodactyl.
#
# NO recompila el panel (no usa yarn/npm), por lo que es compatible con
# cualquier tema, incluido Arix v2.
#
# Uso:   sudo bash install.sh [/ruta/del/panel]
#        (por defecto usa /var/www/pterodactyl)
# ============================================================================
set -e

PANEL="${1:-/var/www/pterodactyl}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$PANEL/artisan" ]; then
  echo "ERROR: No se encontró el panel de Pterodactyl en: $PANEL"
  echo "Uso:   sudo bash install.sh /ruta/del/panel"
  exit 1
fi

echo "==> Instalando la extensión PteroBackups en: $PANEL"

# 1) Copiar archivos (controladores, vistas y scripts)
cp -r "$HERE/panel/app/." "$PANEL/app/"
cp -r "$HERE/panel/resources/." "$PANEL/resources/"
cp -r "$HERE/panel/public/." "$PANEL/public/"
echo "    Archivos copiados."

# 2) Agregar las rutas (solo si no estaban ya)
if ! grep -q 'PteroBackups START' "$PANEL/routes/base.php"; then
  cat "$HERE/routes/base-append.stub" >> "$PANEL/routes/base.php"
  echo "    Rutas de usuario agregadas a routes/base.php"
fi
if ! grep -q 'PteroBackups START' "$PANEL/routes/admin.php"; then
  cat "$HERE/routes/admin-append.stub" >> "$PANEL/routes/admin.php"
  echo "    Rutas de admin agregadas a routes/admin.php"
fi

# 3) Botón "Copias Remotas" en el menú de cada servidor (área de usuario).
#    Se inyecta con un script que CLONA el botón del tema activo:
#    funciona con el panel normal y con temas como Arix.
W="$PANEL/resources/views/templates/wrapper.blade.php"
if [ -f "$W" ] && ! grep -q 'pterobackups/inject.js' "$W"; then
  sed -i 's#</body>#    <script src="/pterobackups/inject.js" defer></script>\n    </body>#' "$W"
  echo "    Menú de usuario inyectado (wrapper.blade.php)."
fi

# 4) Enlace "PteroBackups" en el menú del área admin
A="$PANEL/resources/views/layouts/admin.blade.php"
if [ -f "$A" ] && ! grep -q 'pterobackups/admin-inject.js' "$A"; then
  sed -i 's#</body>#    <script src="/pterobackups/admin-inject.js" defer></script>\n    </body>#' "$A"
  echo "    Menú de admin inyectado (layouts/admin.blade.php)."
fi

# 5) Limpiar cachés del panel y ajustar permisos
cd "$PANEL"
php artisan view:clear   >/dev/null 2>&1 || true
php artisan route:clear  >/dev/null 2>&1 || true
php artisan config:clear >/dev/null 2>&1 || true
COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload -o >/dev/null 2>&1 || true
chown -R www-data:www-data "$PANEL/app" "$PANEL/resources" "$PANEL/public/pterobackups" 2>/dev/null || true

echo ""
echo "=========================================================="
echo " Extensión PteroBackups instalada correctamente."
echo ""
echo " Siguientes pasos:"
echo "  1. Entra a  https://TU-PANEL/admin/pterobackups"
echo "     (también aparece 'PteroBackups' en el menú del admin)"
echo "  2. Pega la URL del sistema de copias y la clave de API."
echo "     Ambos están en el sistema: Configuración -> Extensión del panel."
echo "  3. Guarda: la conexión se prueba automáticamente."
echo ""
echo " Los usuarios verán 'Copias Remotas' en el menú de su servidor."
echo "=========================================================="
