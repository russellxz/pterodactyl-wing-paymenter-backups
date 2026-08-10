#!/bin/bash
# Desinstalador de la extensión PteroBackups.
# Uso:   sudo bash uninstall.sh [/ruta/del/panel] [--no-build]
set -e

PANEL="/var/www/pterodactyl"
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    *) PANEL="$arg" ;;
  esac
done

if [ ! -f "$PANEL/artisan" ]; then
  echo "ERROR: No se encontró el panel de Pterodactyl en: $PANEL"
  exit 1
fi

echo "==> Desinstalando la extensión PteroBackups de: $PANEL"

# Botón del menú de Arix.
#
# Solo hace falta si el botón se puso en la lista de enlaces del tema (la que
# vive en la base de datos). Con el hueco de extensiones no se usa esa lista,
# asi que ni se toca: el archivo del hueco se borra mas abajo y ya esta.
if [ ! -d "$PANEL/resources/scripts/components/server/extensions/pterobackups" ] \
   && { [ -d "$PANEL/app/Http/Controllers/Admin/Arix" ] || [ -f "$PANEL/config/arixTheme.php" ]; }; then
  (cd "$PANEL" && php artisan pterobackups:arix-link --remove) >/dev/null 2>&1 || true
fi

# Revertir el ajuste de la ruta comodín de React
sed -i 's#api|auth|admin|daemon|pterobackups#api|auth|admin|daemon#g' "$PANEL/routes/base.php" 2>/dev/null || true

# Quitar rutas
sed -i '/PteroBackups START/,/PteroBackups END/d' "$PANEL/routes/base.php" 2>/dev/null || true
sed -i '/PteroBackups START/,/PteroBackups END/d' "$PANEL/routes/admin.php" 2>/dev/null || true

# Quitar el botón del menú de admin (bloque Blade)
ADMIN_LAYOUT="$PANEL/resources/views/layouts/admin.blade.php"
if [ -f "$ADMIN_LAYOUT" ]; then
  sed -i '/PteroBackups NAV START/,/PteroBackups NAV END/d' "$ADMIN_LAYOUT" 2>/dev/null || true

# Los huecos del tema.
#
# Esto es imprescindible: la entrada del menu llama a route('admin.pterobackups'),
# y sin la extension esa ruta no existe. Si el archivo se queda, route() lanza
# excepcion y el area de administracion ENTERA da error 500.
rm -f  "$PANEL/resources/views/admin/extensions/pterobackups.blade.php"
rm -rf "$PANEL/resources/scripts/components/server/extensions/pterobackups"
(cd "$PANEL" && php artisan view:clear >/dev/null 2>&1) || true
  echo "    Botón del menú de admin retirado."
fi

# Quitar el botón del menú de usuario (entrada nativa en routes.ts).
# Las inserciones van entre marcas, así que borrarlas deja el archivo BYTE A
# BYTE como estaba antes de instalar.
ROUTES_TS="$PANEL/resources/scripts/routers/routes.ts"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHER="$HERE/tools/patch-routes.php"
NEEDS_BUILD=0

# 1) Versión actual: el parcheador restaura routes.ts desde la copia del
#    original que guardó al instalar, así queda BYTE A BYTE como estaba.
if [ -f "$ROUTES_TS" ] && [ -f "$PATCHER" ]; then
  if php "$PATCHER" "$PANEL" --remove 2>/dev/null | grep -qv "No estaba puesto"; then
    grep -q 'pterobackups' "$ROUTES_TS" || NEEDS_BUILD=1
  fi
  grep -q 'pterobackups:inicio\|PteroBackupsContainer' "$ROUTES_TS" || echo "    routes.ts limpio."
fi

# 2) Versiones anteriores, que dejaban el bloque con otras marcas o sin ellas.
if [ -f "$ROUTES_TS" ] && grep -q 'PteroBackups START' "$ROUTES_TS"; then
  sed -i '/\/\/ PteroBackups START/,/\/\/ PteroBackups END/d' "$ROUTES_TS"
  echo "    Entrada con marcas antiguas retirada de routes.ts."
  NEEDS_BUILD=1
fi
if [ -f "$ROUTES_TS" ] && grep -q 'PteroBackupsContainer' "$ROUTES_TS"; then
  sed -i "\#components/server/pterobackups/PteroBackupsContainer#d" "$ROUTES_TS"
  awk '
    { lines[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        if (lines[i] ~ /path: .\/pterobackups./) {
          for (j = i - 1; j >= 1; j--) { if (lines[j] ~ /^[[:space:]]*\{[[:space:]]*$/) { skipFrom = j; break } }
          for (k = i; k <= NR; k++) { if (lines[k] ~ /^[[:space:]]*\},[[:space:]]*$/) { skipTo = k; break } }
        }
      }
      for (i = 1; i <= NR; i++) if (i < skipFrom || i > skipTo) print lines[i]
    }
  ' "$ROUTES_TS" > "$ROUTES_TS.pbtmp" && mv "$ROUTES_TS.pbtmp" "$ROUTES_TS"
  echo "    Entrada sin marcas retirada de routes.ts."
  NEEDS_BUILD=1
fi
rm -f "$ROUTES_TS.pterobackups-original"

# Restos de la versión antigua, que metía el botón con JavaScript inyectado
# en TODAS las plantillas del panel. Se limpian una por una.
for FILE in $(grep -rl 'pterobackups/inject.js\|pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null || true); do
  sed -i '\#pterobackups/inject.js#d;\#pterobackups/admin-inject.js#d' "$FILE" 2>/dev/null || true
  echo "    Script inyectado retirado de $(basename "$FILE")"
done

# Por si quedaron varios bloques del menú de admin de instalaciones repetidas,
# el borrado por marcas de arriba ya los quita todos. Comprobamos que no queda.
if grep -q 'pterobackups' "$PANEL/resources/views/layouts/admin.blade.php" 2>/dev/null; then
  echo "    AVISO: queda alguna referencia suelta en admin.blade.php:"
  grep -n 'pterobackups' "$PANEL/resources/views/layouts/admin.blade.php" | sed 's/^/      /'
fi

# Quitar archivos
rm -rf "$PANEL/app/Http/Controllers/PteroBackups" \
       "$PANEL/app/PteroBackups" \
       "$PANEL/app/Console/Commands/PteroBackupsArixLinkCommand.php" \
       "$PANEL/resources/views/admin/pterobackups" \
       "$PANEL/resources/views/pterobackups" \
       "$PANEL/resources/scripts/components/server/pterobackups" \
       "$PANEL/resources/scripts/api/server/pterobackups" \
       "$PANEL/public/pterobackups"

cd "$PANEL"
php artisan view:clear  >/dev/null 2>&1 || true
php artisan route:clear >/dev/null 2>&1 || true

if [ "$NEEDS_BUILD" = "1" ] && [ "$DO_BUILD" = "1" ] && command -v yarn >/dev/null 2>&1; then
  echo "==> Recompilando el panel para quitar el botón (tarda varios minutos)..."
  yarn build:production
elif [ "$NEEDS_BUILD" = "1" ]; then
  echo "    Recompila el panel para que desaparezca el botón del menú de usuario:"
  echo "      cd $PANEL && yarn build:production"
fi

echo "==> Extensión desinstalada."
echo "    (La URL y la clave guardadas en la BD del panel se conservan por si reinstalas.)"
