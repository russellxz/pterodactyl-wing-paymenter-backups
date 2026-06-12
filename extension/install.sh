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

# 3) Inyectar los scripts del menú (área de usuario y área admin).
#    El script CLONA un botón del tema activo, así funciona con el panel
#    normal y con temas como Arix.
inject_script() {
  FILE="$1"; SRC="$2"
  if [ ! -f "$FILE" ]; then
    echo "    AVISO: no existe $FILE (¿ruta del panel correcta?)"
    return
  fi
  if ! grep -q "$SRC" "$FILE"; then
    if grep -q '</body>' "$FILE"; then
      sed -i "s#</body>#    <script src=\"$SRC\" defer></script>\n    </body>#" "$FILE"
    else
      printf '\n<script src="%s" defer></script>\n' "$SRC" >> "$FILE"
    fi
  fi
  if grep -q "$SRC" "$FILE"; then
    echo "    OK: $SRC inyectado en $(basename "$FILE")"
  else
    echo "    AVISO: no se pudo inyectar $SRC en $FILE"
  fi
}

inject_script "$PANEL/resources/views/templates/wrapper.blade.php" "/pterobackups/inject.js"
inject_script "$PANEL/resources/views/layouts/admin.blade.php" "/pterobackups/admin-inject.js"

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
echo " Los usuarios verán 'Backup 2.0' en el menú de su servidor."
echo "=========================================================="
