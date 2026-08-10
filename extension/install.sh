#!/bin/bash
# ============================================================================
# Instalador de la extensión PteroBackups para el panel de Pterodactyl.
#
# El botón del menú se registra de forma NATIVA, igual que lo hace cualquier
# modificación seria del panel:
#
#   - Área de usuario: se añade una entrada en resources/scripts/routers/routes.ts
#     y se recompila el panel. El menú lateral de cada servidor se dibuja a
#     partir de ese archivo, así que el botón sale solo, sin JavaScript que
#     ande rastreando la página.
#   - Área de admin: se añade un <li> en resources/views/layouts/admin.blade.php.
#     Esa parte del panel es Blade (HTML del servidor), así que NO hace falta
#     recompilar nada.
#
# Antes el botón se metía con un script que escaneaba el DOM constantemente.
# Eso disparaba la CPU del navegador y hacía que Cloudflare tomara al usuario
# por un bot y le mostrara su pantalla de comprobación. Con el método nativo
# no se ejecuta ni una línea de JavaScript extra.
#
# Uso:   sudo bash install.sh [/ruta/del/panel] [--no-build]
#        (por defecto usa /var/www/pterodactyl)
#        --no-build  ->  no recompila el panel (útil si prefieres hacerlo tú;
#                        el botón del área de usuario no saldrá hasta que
#                        ejecutes "yarn build:production" en el panel)
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
  echo "Uso:   sudo bash install.sh /ruta/del/panel [--no-build]"
  exit 1
fi

echo "==> Instalando la extensión PteroBackups en: $PANEL"

# ---------------------------------------------------------------------------
# 1) Copiar archivos (controladores, vistas, estilos y componentes React)
# ---------------------------------------------------------------------------
cp -r "$HERE/panel/app/." "$PANEL/app/"
cp -r "$HERE/panel/resources/." "$PANEL/resources/"
cp -r "$HERE/panel/public/." "$PANEL/public/"
echo "    Archivos copiados."

# Restos de la versión anterior, que metía el botón con JavaScript.
rm -f "$PANEL/public/pterobackups/inject.js" "$PANEL/public/pterobackups/admin-inject.js"
for FILE in $(grep -rl 'pterobackups/inject.js\|pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null || true); do
  sed -i '\#pterobackups/inject.js#d;\#pterobackups/admin-inject.js#d' "$FILE" 2>/dev/null || true
  echo "    Limpiada la inyección antigua en $(basename "$FILE")"
done

# ---------------------------------------------------------------------------
# 2) Rutas de la extensión (solo si no estaban ya)
# ---------------------------------------------------------------------------
if ! grep -q 'PteroBackups START' "$PANEL/routes/base.php"; then
  cat "$HERE/routes/base-append.stub" >> "$PANEL/routes/base.php"
  echo "    Rutas de usuario agregadas a routes/base.php"
fi
if ! grep -q 'PteroBackups START' "$PANEL/routes/admin.php"; then
  cat "$HERE/routes/admin-append.stub" >> "$PANEL/routes/admin.php"
  echo "    Rutas de admin agregadas a routes/admin.php"
fi

# La ruta comodín de React atrapa cualquier dirección que no empiece por
# api/auth/admin/daemon. Hay que excluir /pterobackups para que las peticiones
# de la página (listar copias, restaurar, descargar) lleguen a su controlador.
if grep -q 'api|auth|admin|daemon|pterobackups' "$PANEL/routes/base.php"; then
  echo "    Ruta comodín de React ya estaba ajustada."
elif grep -q 'api|auth|admin|daemon' "$PANEL/routes/base.php"; then
  sed -i 's#api|auth|admin|daemon#api|auth|admin|daemon|pterobackups#g' "$PANEL/routes/base.php"
  echo "    OK: ruta comodín de React ajustada para dejar pasar /pterobackups."
else
  echo "    AVISO: no se encontró la ruta comodín de React en routes/base.php."
fi

# ---------------------------------------------------------------------------
# 3) Botón del ÁREA DE USUARIO: entrada nativa en routes.ts
# ---------------------------------------------------------------------------
ROUTES_TS="$PANEL/resources/scripts/routers/routes.ts"
if [ ! -f "$ROUTES_TS" ]; then
  echo "    AVISO: no existe $ROUTES_TS."
  echo "           El botón del área de usuario no se podrá añadir."
  DO_BUILD=0
elif grep -q 'PteroBackupsContainer' "$ROUTES_TS"; then
  echo "    El botón de usuario ya estaba registrado en routes.ts."
else
  # Dos inserciones en una pasada, cada una entre marcas para poder quitarlas
  # después dejando el archivo BYTE A BYTE como estaba:
  #   - el import, delante del primero que haya (en TS el orden da igual)
  #   - la entrada del menú, al final del array de rutas del servidor. Ese
  #     array es el último que se cierra en el archivo, así que va justo
  #     delante de su "]," final.
  IMPORT=$(cat <<'TSEOF'
// PteroBackups START
import PteroBackupsContainer from '@/components/server/pterobackups/PteroBackupsContainer';
// PteroBackups END
TSEOF
)
  ENTRY=$(cat <<'TSEOF'
        // PteroBackups START
        {
            path: '/pterobackups',
            permission: 'backup.*',
            name: 'Backup 2.0',
            component: PteroBackupsContainer,
        },
        // PteroBackups END
TSEOF
)
  awk -v imp="$IMPORT" -v block="$ENTRY" '
    {
      lines[NR] = $0
      if (!firstImport && $0 ~ /^import /) firstImport = NR
      if ($0 ~ /^[[:space:]]*\],[[:space:]]*$/) lastClose = NR
    }
    END {
      for (i = 1; i <= NR; i++) {
        if (i == firstImport) print imp
        if (i == lastClose) print block
        print lines[i]
      }
    }
  ' "$ROUTES_TS" > "$ROUTES_TS.pbtmp" && mv "$ROUTES_TS.pbtmp" "$ROUTES_TS"

  if grep -q 'PteroBackupsContainer' "$ROUTES_TS"; then
    echo "    OK: botón 'Backup 2.0' registrado en routes.ts"
  else
    echo "    AVISO: no se pudo registrar el botón en routes.ts (revísalo a mano)."
    DO_BUILD=0
  fi
fi

# ---------------------------------------------------------------------------
# 4) Botón del ÁREA DE ADMIN: <li> nativo en la plantilla Blade
#    (esta parte del panel no es React, así que no hay que recompilar nada)
# ---------------------------------------------------------------------------
ADMIN_LAYOUT="$PANEL/resources/views/layouts/admin.blade.php"
if [ ! -f "$ADMIN_LAYOUT" ]; then
  echo "    AVISO: no existe $ADMIN_LAYOUT (el menú de admin no se tocará)."
elif grep -q 'PteroBackups NAV' "$ADMIN_LAYOUT"; then
  echo "    El botón de admin ya estaba en el menú."
else
  NAV=$(cat <<'BLADEEOF'
                    {{-- PteroBackups NAV START (gestionado por extension/install.sh) --}}
                    <li class="{{ Route::currentRouteNamed('admin.pterobackups*') ? 'active' : '' }}">
                        <a href="{{ route('admin.pterobackups') }}">
                            <i class="fa fa-cloud-download"></i> <span>PteroBackups</span>
                        </a>
                    </li>
                    {{-- PteroBackups NAV END --}}
BLADEEOF
)
  # Se cuelga justo detrás de la entrada "Nodes", que existe en el panel
  # normal y en los temas que respetan su plantilla.
  awk -v block="$NAV" '
    { print }
    /route\(.admin\.nodes.\)/ { found = 1 }
    found && /<\/li>/ { print block; found = 0 }
  ' "$ADMIN_LAYOUT" > "$ADMIN_LAYOUT.pbtmp" && mv "$ADMIN_LAYOUT.pbtmp" "$ADMIN_LAYOUT"

  if grep -q 'PteroBackups NAV' "$ADMIN_LAYOUT"; then
    echo "    OK: botón 'PteroBackups' añadido al menú de admin."
  else
    echo "    AVISO: no se encontró la entrada 'Nodes' en el menú de admin."
    echo "           Entra directamente a  https://TU-PANEL/admin/pterobackups"
  fi
fi

# ---------------------------------------------------------------------------
# 5) Recompilar el panel (solo por el botón del área de usuario)
# ---------------------------------------------------------------------------
BUILD_OK=0
STAMP="$(date +%Y%m%d-%H%M%S)"
BUILD_LOG="$PANEL/storage/logs/pterobackups-build-$STAMP.log"
ASSETS_BACKUP="$PANEL/storage/pterobackups-assets-$STAMP"
SWAPFILE="/swapfile-pterobackups"

# Deshace la entrada del menú de usuario, dejando routes.ts como estaba.
revert_routes_ts() {
  [ -f "$ROUTES_TS" ] || return 0
  sed -i '/\/\/ PteroBackups START/,/\/\/ PteroBackups END/d' "$ROUTES_TS"
}

# Devuelve el frontend que había antes de compilar.
restore_assets() {
  if [ -d "$ASSETS_BACKUP/assets" ]; then
    rm -rf "$PANEL/public/assets"
    cp -a "$ASSETS_BACKUP/assets" "$PANEL/public/assets"
    chown -R www-data:www-data "$PANEL/public/assets" 2>/dev/null || true
    echo "    Frontend anterior restaurado: el panel sigue funcionando."
  fi
}

# El build puede terminar con código 0 y no haber generado nada, así que no
# basta con mirar el código de salida: hay que comprobar que el bundle está.
frontend_ok() {
  ls "$PANEL/public/assets/bundle."*.js >/dev/null 2>&1 && return 0
  # Por si un tema cambia el nombre del bundle: al menos un .js con tamaño real.
  local total
  total=$(cat "$PANEL/public/assets/"*.js 2>/dev/null | wc -c)
  [ "${total:-0}" -gt 500000 ]
}

cleanup_swap() {
  if [ -f "$SWAPFILE" ]; then
    swapoff "$SWAPFILE" 2>/dev/null || true
    rm -f "$SWAPFILE"
  fi
}

if [ "$DO_BUILD" = "1" ]; then
  if ! command -v yarn >/dev/null 2>&1; then
    echo ""
    echo "    AVISO: 'yarn' no está instalado, así que no se puede recompilar."
    echo "           El área de admin ya funciona; para que salga el botón en el"
    echo "           menú de los usuarios, instala yarn y recompila:"
    echo "             npm install -g yarn"
    echo "             cd $PANEL && yarn && yarn build:production"
    revert_routes_ts
    echo "    (La entrada de routes.ts se ha quitado para no dejarla a medias.)"
  else
    echo ""
    echo "==> Preparando la recompilación..."

    # 1) RED DE SEGURIDAD: copia del frontend actual. "yarn build:production"
    #    ejecuta antes "yarn run clean", que BORRA public/assets/*.js. Si el
    #    build falla después, el panel se queda en blanco. Con esta copia lo
    #    devolvemos tal cual estaba.
    if [ -d "$PANEL/public/assets" ]; then
      mkdir -p "$ASSETS_BACKUP"
      cp -a "$PANEL/public/assets" "$ASSETS_BACKUP/assets"
      echo "    Copia del frontend actual guardada en: $ASSETS_BACKUP"
    else
      echo "    AVISO: no existe public/assets (¿el panel nunca se compiló?)."
    fi

    # 2) Memoria: compilar el panel pide unos 2 GB. Si node intenta usar más
    #    de la que hay libre, el sistema lo mata y solo se ve "exit code 1".
    MEM_FREE=$(free -m 2>/dev/null | awk '/^Mem:/ {print ($7 != "" && $7 != 0 ? $7 : $4)}')
    MEM_FREE=${MEM_FREE:-2048}
    SWAP_TOTAL=$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}')
    SWAP_TOTAL=${SWAP_TOTAL:-0}
    if [ "$MEM_FREE" -lt 2048 ] && [ "$SWAP_TOTAL" -lt 1024 ] && command -v fallocate >/dev/null 2>&1; then
      echo "    Poca memoria libre (${MEM_FREE} MB) y sin swap: creando swap temporal de 4 GB..."
      trap cleanup_swap EXIT
      if fallocate -l 4G "$SWAPFILE" 2>/dev/null && chmod 600 "$SWAPFILE" && mkswap "$SWAPFILE" >/dev/null 2>&1 && swapon "$SWAPFILE" 2>/dev/null; then
        echo "    Swap temporal activada (se quita sola al terminar)."
        MEM_FREE=$((MEM_FREE + 4096))
      else
        cleanup_swap
        echo "    No se pudo crear la swap; se sigue igualmente."
      fi
    fi
    NODE_MEM=$((MEM_FREE * 75 / 100))
    [ "$NODE_MEM" -lt 1024 ] && NODE_MEM=1024
    [ "$NODE_MEM" -gt 4096 ] && NODE_MEM=4096
    echo "    Memoria para node: ${NODE_MEM} MB (libre: ${MEM_FREE} MB)"

    echo "==> Recompilando el panel (tarda varios minutos, no lo interrumpas)..."
    mkdir -p "$(dirname "$BUILD_LOG")"
    cd "$PANEL"
    set +e
    NODE_OPTIONS="--max-old-space-size=$NODE_MEM" \
      sh -c 'yarn install --network-timeout 600000 && yarn build:production' > "$BUILD_LOG" 2>&1
    BUILD_RC=$?
    set -e

    if [ "$BUILD_RC" = "0" ] && frontend_ok; then
      BUILD_OK=1
      cleanup_swap
      echo "    Panel recompilado y frontend verificado."
    else
      cleanup_swap
      echo ""
      echo "    ============================================================="
      if [ "$BUILD_RC" = "0" ]; then
        echo "    EL BUILD DIJO QUE SÍ, PERO NO GENERÓ FRONTEND."
      else
        echo "    LA RECOMPILACIÓN FALLÓ (código $BUILD_RC)."
      fi
      echo "    ============================================================="
      # Diagnóstico legible: primero las causas típicas, luego el error real
      # sin el ruido de Browserslist / Tailwind / DeprecationWarning.
      if grep -qiE "heap out of memory|Allocation failed|Killed|JavaScript heap" "$BUILD_LOG"; then
        echo "    CAUSA: se quedó SIN MEMORIA."
        echo "    Solución: añade swap y vuelve a ejecutar el instalador:"
        echo "      fallocate -l 4G /swapfile && chmod 600 /swapfile && \\"
        echo "        mkswap /swapfile && swapon /swapfile && \\"
        echo "        echo '/swapfile none swap sw 0 0' >> /etc/fstab"
      elif grep -q "ERROR in" "$BUILD_LOG"; then
        echo "    Errores de compilación encontrados:"
        grep -A3 "ERROR in" "$BUILD_LOG" | head -n 30 | sed 's/^/      /'
      else
        echo "    Últimas líneas del registro:"
        grep -viE "Browserslist|caniuse|tailwindcss|DeprecationWarning|warning |^warn |funding|npm notice" "$BUILD_LOG" \
          | tail -n 20 | sed 's/^/      /'
      fi
      echo "    -------------------------------------------------------------"
      echo "    Registro completo: $BUILD_LOG"
      echo "    -------------------------------------------------------------"
      # VUELTA ATRÁS: frontend y routes.ts como estaban. El panel NO se queda
      # en blanco y el archivo queda idéntico al original.
      restore_assets
      revert_routes_ts
      echo "    Entrada de routes.ts retirada (el archivo queda como estaba)."
      echo "    El área de admin y la página siguen instaladas y funcionando."
      echo "    ============================================================="
    fi
  fi
else
  echo ""
  echo "    Recompilación omitida (--no-build)."
  revert_routes_ts
  echo "    La entrada de routes.ts se ha quitado para no dejar el panel a medias."
  echo "    El área de admin funciona ya. Para el botón del menú de usuario,"
  echo "    vuelve a ejecutar el instalador SIN --no-build."
fi

# ---------------------------------------------------------------------------
# 5b) Tema Arix: su menú lateral NO sale de routes.ts, sino de una lista de
#     enlaces guardada en la base de datos. Añadimos ahí la entrada (eso no
#     necesita recompilar). Solo tiene sentido si la página existe, o sea si
#     el panel se llegó a compilar con la ruta dentro.
# ---------------------------------------------------------------------------
if [ -d "$PANEL/app/Http/Controllers/Admin/Arix" ] || [ -f "$PANEL/config/arixTheme.php" ]; then
  echo ""
  echo "==> Tema Arix detectado."
  if [ "$BUILD_OK" = "1" ]; then
    (cd "$PANEL" && php artisan pterobackups:arix-link) || \
      echo "    AVISO: no se pudo añadir el botón al menú de Arix (mira el mensaje de arriba)."
  else
    echo "    El botón del menú NO se añade todavía: sin recompilar, la página"
    echo "    daría 'no encontrada' al pulsarlo. Cuando el build funcione, ejecuta:"
    echo "      cd $PANEL && php artisan pterobackups:arix-link"
  fi
fi

# ---------------------------------------------------------------------------
# 6) Limpiar cachés del panel y ajustar permisos
# ---------------------------------------------------------------------------
cd "$PANEL"
php artisan view:clear   >/dev/null 2>&1 || true
php artisan route:clear  >/dev/null 2>&1 || true
php artisan config:clear >/dev/null 2>&1 || true
COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload -o >/dev/null 2>&1 || true
chown -R www-data:www-data "$PANEL/app" "$PANEL/resources" "$PANEL/public" 2>/dev/null || true

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
