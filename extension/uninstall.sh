#!/bin/bash
# ============================================================================
# Desinstalador de la extensión PteroBackups.
#
#   sudo bash uninstall.sh [/ruta/del/panel] [--no-build]
#   (por defecto usa /var/www/pterodactyl)
#
# Deja el panel como estaba antes de instalarla:
#
#   - Quita el botón "Backup 2.0" del menú de los clientes Y RECOMPILA, que es
#     lo que de verdad lo hace desaparecer. Mientras el panel no se recompile,
#     el botón sigue dentro del frontend ya compilado aunque se borren los
#     archivos, y al pulsarlo daría error.
#   - Quita el botón "PteroBackups" del menú del admin, tanto si está en el
#     hueco del tema como si está metido en la plantilla.
#   - Quita las rutas de routes/base.php y routes/admin.php.
#   - Borra los archivos de la extensión, incluidos los de la versión antigua
#     que metía el botón con JavaScript inyectado.
#
# Si la recompilación fallara, el frontend anterior vuelve tal cual: el panel
# NO se queda en blanco.
#
# Lo ÚNICO que se conserva es la URL y la clave del sistema de copias
# guardadas en la base de datos del panel, por si se reinstala.
# ============================================================================
set -e

PANEL="/var/www/pterodactyl"
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    *) PANEL="$arg" ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$PANEL/artisan" ]; then
  echo "ERROR: No se encontró el panel de Pterodactyl en: $PANEL"
  echo "Uso:   sudo bash uninstall.sh /ruta/del/panel [--no-build]"
  exit 1
fi

TERMINADO=0
LINEA_ACTUAL="?"
trap 'LINEA_ACTUAL=$LINENO' ERR
trap 'RC=$?; if [ "$RC" != "0" ] && [ "$TERMINADO" != "1" ]; then
  echo ""
  echo "    ============================================================="
  echo "    EL DESINSTALADOR SE HA PARADO (código '"'"'$RC'"'"', línea '"'"'$LINEA_ACTUAL'"'"')."
  echo "    ============================================================="
  echo "    Vuelve a lanzarlo: es repetible, no pasa nada por ejecutarlo"
  echo "    dos veces."
fi' EXIT

echo "==> Desinstalando la extensión PteroBackups de: $PANEL"

SLOT_CLIENTE="$PANEL/resources/scripts/components/server/extensions/pterobackups"
ADMIN_LAYOUT="$PANEL/resources/views/layouts/admin.blade.php"
ROUTES_TS="$PANEL/resources/scripts/routers/routes.ts"
PATCHER="$HERE/tools/patch-routes.php"

# Hay que recompilar si el botón del cliente estaba metido en el frontend, sea
# por el hueco del tema o por routes.ts.
NEEDS_BUILD=0
[ -d "$SLOT_CLIENTE" ] && NEEDS_BUILD=1

# ---------------------------------------------------------------------------
# 1) Botón del menú de Arix guardado en la base de datos.
#
# Se intenta siempre y ANTES de borrar los archivos, porque el comando que lo
# quita es uno de los archivos que se borran. Si no estaba puesto, el comando
# no hace nada: es inofensivo.
# ---------------------------------------------------------------------------
if [ -f "$PANEL/app/Console/Commands/PteroBackupsArixLinkCommand.php" ]; then
  (cd "$PANEL" && php artisan pterobackups:arix-link --remove) >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# 2) Rutas
# ---------------------------------------------------------------------------
sed -i 's#api|auth|admin|daemon|pterobackups#api|auth|admin|daemon#g' "$PANEL/routes/base.php" 2>/dev/null || true
sed -i '/PteroBackups START/,/PteroBackups END/d' "$PANEL/routes/base.php" 2>/dev/null || true
sed -i '/PteroBackups START/,/PteroBackups END/d' "$PANEL/routes/admin.php" 2>/dev/null || true
echo "    Rutas retiradas."

# ---------------------------------------------------------------------------
# 3) Botón del menú de ADMIN
#
# Los dos sitios donde puede estar, cada uno por su cuenta.
#
# El archivo del hueco es IMPRESCINDIBLE quitarlo: llama a
# route('admin.pterobackups'), y sin la extensión esa ruta no existe. Si se
# quedara, el área de administración ENTERA daría error 500. Antes esto estaba
# metido dentro del "if" de la plantilla, así que en un panel sin esa plantilla
# no se borraba nunca.
# ---------------------------------------------------------------------------
rm -f "$PANEL/resources/views/admin/extensions/pterobackups.blade.php"

if [ -f "$ADMIN_LAYOUT" ]; then
  sed -i '/PteroBackups NAV START/,/PteroBackups NAV END/d' "$ADMIN_LAYOUT" 2>/dev/null || true
fi
echo "    Botón del menú de admin retirado."

# ---------------------------------------------------------------------------
# 4) Botón del menú de USUARIO
# ---------------------------------------------------------------------------
# 4a) Hueco del tema.
if [ -d "$SLOT_CLIENTE" ]; then
  rm -rf "$SLOT_CLIENTE"
  echo "    Botón del hueco del tema retirado."
fi

# 4b) Entrada en routes.ts. El parcheador restaura el archivo desde la copia
#     del original que guardó al instalar, así queda BYTE A BYTE como estaba.
if [ -f "$ROUTES_TS" ] && [ -f "$PATCHER" ] && grep -q 'pterobackups' "$ROUTES_TS" 2>/dev/null; then
  php "$PATCHER" "$PANEL" --remove >/dev/null 2>&1 || true
  grep -q 'pterobackups' "$ROUTES_TS" 2>/dev/null || NEEDS_BUILD=1
fi

# 4c) Versiones anteriores, que dejaban el bloque con otras marcas o sin ellas.
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

# ---------------------------------------------------------------------------
# 5) Restos de la versión antigua, la que metía el botón con JavaScript
#    inyectado en las plantillas del panel.
# ---------------------------------------------------------------------------
for FILE in $(grep -rl 'pterobackups/inject.js\|pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null || true); do
  sed -i '\#pterobackups/inject.js#d;\#pterobackups/admin-inject.js#d' "$FILE" 2>/dev/null || true
  echo "    Script inyectado retirado de $(basename "$FILE")"
done

if grep -q 'pterobackups' "$ADMIN_LAYOUT" 2>/dev/null; then
  echo "    AVISO: queda alguna referencia suelta en admin.blade.php:"
  grep -n 'pterobackups' "$ADMIN_LAYOUT" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# 6) Archivos
# ---------------------------------------------------------------------------
rm -rf "$PANEL/app/Http/Controllers/PteroBackups" \
       "$PANEL/app/PteroBackups" \
       "$PANEL/app/Console/Commands/PteroBackupsArixLinkCommand.php" \
       "$PANEL/resources/views/admin/pterobackups" \
       "$PANEL/resources/views/pterobackups" \
       "$PANEL/resources/scripts/components/server/pterobackups" \
       "$PANEL/resources/scripts/api/server/pterobackups" \
       "$PANEL/public/pterobackups"
echo "    Archivos borrados."

cd "$PANEL"
php artisan view:clear   >/dev/null 2>&1 || true
php artisan route:clear  >/dev/null 2>&1 || true
php artisan config:clear >/dev/null 2>&1 || true
COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload -o >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 7) Recompilar para que el botón desaparezca de verdad.
#
# Con la misma red de seguridad que el instalador: "yarn build:production"
# ejecuta antes "yarn run clean", que BORRA public/assets/*.js. Si el build
# fallara sin copia, el panel se quedaría EN BLANCO.
# ---------------------------------------------------------------------------
BUILD_PENDIENTE=0

# Última comprobación: aunque no hubiéramos tocado nada del frontend, si el
# botón sigue DENTRO del panel ya compilado hay que recompilar igual. Si no,
# se quedaría un botón que lleva a una página que ya no existe.
if [ "$NEEDS_BUILD" != "1" ] && grep -rlq "Backup 2\.0" "$PANEL/public/assets/" 2>/dev/null; then
  NEEDS_BUILD=1
  echo "    El botón sigue dentro del frontend compilado: hay que recompilar."
fi

if [ "$NEEDS_BUILD" != "1" ]; then
  :
elif [ "$DO_BUILD" != "1" ]; then
  BUILD_PENDIENTE=1
  echo ""
  echo "    Recompilación omitida (--no-build)."
elif ! command -v yarn >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  BUILD_PENDIENTE=1
  echo ""
  echo "    AVISO: no hay ni yarn ni npm, así que no se puede recompilar."
else
  if command -v yarn >/dev/null 2>&1; then BUILD_CMD="yarn build:production"; else BUILD_CMD="npm run build:production"; fi

  STAMP="$(date +%Y%m%d-%H%M%S)"
  BUILD_LOG="$PANEL/storage/logs/pterobackups-uninstall-build-$STAMP.log"
  ASSETS_BACKUP="$PANEL/storage/pterobackups-assets-$STAMP"

  if [ -d "$PANEL/public/assets" ]; then
    mkdir -p "$ASSETS_BACKUP"
    cp -a "$PANEL/public/assets" "$ASSETS_BACKUP/assets"
  fi

  MEM_FREE=$(free -m 2>/dev/null | awk '/^Mem:/ {print ($7 != "" && $7 != 0 ? $7 : $4)}')
  MEM_FREE=${MEM_FREE:-2048}
  NODE_MEM=$((MEM_FREE * 75 / 100))
  [ "$NODE_MEM" -lt 1024 ] && NODE_MEM=1024
  [ "$NODE_MEM" -gt 4096 ] && NODE_MEM=4096

  echo ""
  echo "==> Recompilando el panel para quitar el botón (tarda varios minutos)..."
  mkdir -p "$(dirname "$BUILD_LOG")"

  set +e
  NODE_OPTIONS="--max-old-space-size=$NODE_MEM" sh -c "$BUILD_CMD" > "$BUILD_LOG" 2>&1
  BUILD_RC=$?
  set -e

  if [ "$BUILD_RC" = "0" ] && ls "$PANEL/public/assets/"*.js >/dev/null 2>&1; then
    echo "    Panel recompilado: el botón ya no está."
    chown -R www-data:www-data "$PANEL/public/assets" 2>/dev/null || true
    # Las copias de seguridad de public/assets ya no hacen falta: se van todas,
    # que cada una ocupa lo que pese el frontend entero.
    rm -rf "$PANEL/storage/pterobackups-assets-"* 2>/dev/null || true
  else
    BUILD_PENDIENTE=1
    echo ""
    echo "    ============================================================="
    echo "    LA RECOMPILACIÓN FALLÓ (código $BUILD_RC)."
    echo "    ============================================================="
    if grep -qiE "heap out of memory|Allocation failed|Killed|JavaScript heap" "$BUILD_LOG"; then
      echo "    CAUSA: se quedó SIN MEMORIA. Añade swap y vuelve a intentarlo:"
      echo "      fallocate -l 4G /swapfile && chmod 600 /swapfile && \\"
      echo "        mkswap /swapfile && swapon /swapfile"
    else
      echo "    Últimas líneas del registro:"
      grep -viE "Browserslist|caniuse|tailwindcss|DeprecationWarning|warning |^warn |funding|npm notice" "$BUILD_LOG" \
        | tail -n 15 | sed 's/^/      /'
    fi
    echo "    Registro completo: $BUILD_LOG"
    if [ -d "$ASSETS_BACKUP/assets" ]; then
      rm -rf "$PANEL/public/assets"
      cp -a "$ASSETS_BACKUP/assets" "$PANEL/public/assets"
      chown -R www-data:www-data "$PANEL/public/assets" 2>/dev/null || true
      echo "    Frontend anterior restaurado: el panel NO se queda en blanco."
    fi
    echo "    ============================================================="
  fi
fi

TERMINADO=1

echo ""
echo "=========================================================="
echo " Extensión PteroBackups desinstalada."
if [ "$BUILD_PENDIENTE" = "1" ]; then
  echo ""
  echo " FALTA UN PASO: el botón 'Backup 2.0' seguirá saliendo en el menú"
  echo " de los clientes hasta que recompiles el panel:"
  echo "     cd $PANEL && yarn build:production"
fi
echo ""
echo " La URL y la clave guardadas en la base de datos se conservan"
echo " por si vuelves a instalarla."
echo "=========================================================="
