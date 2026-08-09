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

# Botón del menú de Arix (vive en la base de datos, no en un archivo)
if [ -d "$PANEL/app/Http/Controllers/Admin/Arix" ] || [ -f "$PANEL/config/arixTheme.php" ]; then
  (cd "$PANEL" && php artisan pterobackups:arix-link --remove) 2>/dev/null || true
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
  echo "    Botón del menú de admin retirado."
fi

# Quitar el botón del menú de usuario (entrada nativa en routes.ts)
ROUTES_TS="$PANEL/resources/scripts/routers/routes.ts"
NEEDS_BUILD=0
if [ -f "$ROUTES_TS" ] && grep -q 'PteroBackupsContainer' "$ROUTES_TS"; then
  # El import y el bloque de la ruta (5 líneas desde el "path: '/pterobackups'"
  # hasta su cierre, más la llave de apertura anterior).
  sed -i "\#components/server/pterobackups/PteroBackupsContainer#d" "$ROUTES_TS"
  awk '
    { lines[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        if (lines[i] ~ /path: .\/pterobackups./) {
          # Borramos hacia atrás la llave de apertura del bloque...
          for (j = i - 1; j >= 1; j--) { if (lines[j] ~ /^[[:space:]]*\{[[:space:]]*$/) { skipFrom = j; break } }
          # ...y hacia delante hasta su cierre.
          for (k = i; k <= NR; k++) { if (lines[k] ~ /^[[:space:]]*\},[[:space:]]*$/) { skipTo = k; break } }
        }
      }
      for (i = 1; i <= NR; i++) if (i < skipFrom || i > skipTo) print lines[i]
    }
  ' "$ROUTES_TS" > "$ROUTES_TS.pbtmp" && mv "$ROUTES_TS.pbtmp" "$ROUTES_TS"
  echo "    Entrada del menú de usuario retirada de routes.ts."
  NEEDS_BUILD=1
fi

# Restos de la versión antigua, que metía el botón con JavaScript
for FILE in $(grep -rl 'pterobackups/inject.js\|pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null || true); do
  sed -i '\#pterobackups/inject.js#d;\#pterobackups/admin-inject.js#d' "$FILE" 2>/dev/null || true
done

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
