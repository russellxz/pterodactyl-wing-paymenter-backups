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

# 2b) La ruta comodín de React del panel atrapa cualquier dirección que no
#     empiece por api/auth/admin/daemon y se la queda (mostrando su 404).
#     Hay que excluir /pterobackups para que nuestras páginas de usuario
#     lleguen a sus rutas.
if grep -q 'api|auth|admin|daemon|pterobackups' "$PANEL/routes/base.php"; then
  echo "    Ruta comodín de React ya estaba ajustada."
elif grep -q 'api|auth|admin|daemon' "$PANEL/routes/base.php"; then
  sed -i 's#api|auth|admin|daemon#api|auth|admin|daemon|pterobackups#g' "$PANEL/routes/base.php"
  echo "    OK: ruta comodín de React ajustada para dejar pasar /pterobackups."
else
  echo "    AVISO: no se encontró la ruta comodín de React en routes/base.php."
  echo "           Si /pterobackups/server/... da error 404, avísame."
fi

# 3) Inyectar los scripts del menú (área de usuario y área admin).
#    El script CLONA un botón del tema activo, así funciona con el panel
#    normal y con temas como Arix.
VERSION_TAG="$(date +%s)"
inject_script() {
  FILE="$1"; SRC="$2"
  if [ ! -f "$FILE" ]; then
    echo "    AVISO: no existe $FILE (¿ruta del panel correcta?)"
    return
  fi
  # Quitar inyecciones anteriores para refrescar la versión (evita la caché
  # de Cloudflare y del navegador, que guardan el .js viejo durante horas)
  sed -i "\\#${SRC}#d" "$FILE"
  TAG="<script src=\"${SRC}?v=${VERSION_TAG}\" defer></script>"
  if grep -q '</body>' "$FILE"; then
    sed -i "s#</body>#    ${TAG}\n    </body>#" "$FILE"
  else
    printf '\n%s\n' "$TAG" >> "$FILE"
  fi
  if grep -q "$SRC" "$FILE"; then
    echo "    OK: ${SRC}?v=${VERSION_TAG} inyectado en $(basename "$FILE")"
  else
    echo "    AVISO: no se pudo inyectar $SRC en $FILE"
  fi
}

ADMIN_LAYOUT="$PANEL/resources/views/layouts/admin.blade.php"

# El script del área de usuario se inyecta en TODAS las plantillas de página
# del panel (la normal y las que agregan temas como Arix), porque algunos
# temas usan su propia plantilla en vez de wrapper.blade.php.
USER_LAYOUTS="$(grep -rl '</body>' "$PANEL/resources/views" 2>/dev/null | grep -vi 'mail\|vendor\|partials\|pterobackups' || true)"
FOUND_USER=0
for FILE in $USER_LAYOUTS; do
  if [ "$FILE" = "$ADMIN_LAYOUT" ]; then
    inject_script "$FILE" "/pterobackups/admin-inject.js"
  else
    inject_script "$FILE" "/pterobackups/inject.js"
    FOUND_USER=1
  fi
done
if [ "$FOUND_USER" = "0" ] && [ -f "$PANEL/resources/views/templates/wrapper.blade.php" ]; then
  inject_script "$PANEL/resources/views/templates/wrapper.blade.php" "/pterobackups/inject.js"
fi
if [ -f "$ADMIN_LAYOUT" ] && ! grep -q 'pterobackups/admin-inject.js' "$ADMIN_LAYOUT"; then
  inject_script "$ADMIN_LAYOUT" "/pterobackups/admin-inject.js"
fi

# Refuerzo para temas como Arix: su wrapper incluye layouts/scripts.blade.php,
# así el botón sobrevive aunque el tema reemplace el wrapper al actualizarse.
S="$PANEL/resources/views/layouts/scripts.blade.php"
if [ -f "$S" ] && ! grep -q 'pterobackups/inject.js' "$S"; then
  printf '\n<script src="/pterobackups/inject.js" defer></script>\n' >> "$S"
  echo "    OK: refuerzo añadido en layouts/scripts.blade.php"
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
echo " Los usuarios verán 'Backup 2.0' en el menú de su servidor."
echo "=========================================================="
