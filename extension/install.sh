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
  # Dos inserciones en una pasada:
  #   - el import, delante del primero que haya (en TS el orden da igual)
  #   - la entrada del menú, al final del array de rutas del servidor. Ese
  #     array es el último que se cierra en el archivo, así que va justo
  #     delante de su "]," final.
  IMPORT="import PteroBackupsContainer from '@/components/server/pterobackups/PteroBackupsContainer';"
  ENTRY=$(cat <<'TSEOF'
        {
            path: '/pterobackups',
            permission: 'backup.*',
            name: 'Backup 2.0',
            component: PteroBackupsContainer,
        },
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
if [ "$DO_BUILD" = "1" ]; then
  if ! command -v yarn >/dev/null 2>&1; then
    echo ""
    echo "    AVISO: 'yarn' no está instalado, así que no se puede recompilar."
    echo "           El área de admin ya funciona; para que salga el botón en el"
    echo "           menú de los usuarios, instala yarn y recompila:"
    echo "             npm install -g yarn"
    echo "             cd $PANEL && yarn && yarn build:production"
  else
    echo ""
    echo "==> Recompilando el panel (tarda varios minutos, no lo interrumpas)..."
    cd "$PANEL"
    yarn install --network-timeout 600000
    yarn build:production
    echo "    Panel recompilado."
  fi
else
  echo ""
  echo "    (Recompilación omitida. El botón del menú de usuario aparecerá"
  echo "     cuando ejecutes:  cd $PANEL && yarn && yarn build:production)"
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
