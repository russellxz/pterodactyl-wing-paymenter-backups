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
# Uso:   sudo bash install.sh [/ruta/del/panel] [--no-build] [--solo-frontend]
#        (por defecto usa /var/www/pterodactyl)
#
#        --no-build       no recompila el panel (útil si prefieres hacerlo tú;
#                         el botón del área de usuario no saldrá hasta que
#                         ejecutes "yarn build:production" en el panel)
#        --solo-frontend  rehace SOLO el botón del cliente y recompila, sin
#                         volver a copiar archivos ni tocar rutas. Para
#                         reintentar cuando la compilación falló. Es lo que
#                         hace install-frontend.sh.
# ============================================================================
set -e

SWAPFILE="/swapfile-pterobackups"

# Quita la swap temporal que se crea para compilar, si se llegó a crear.
cleanup_swap() {
  if [ -f "$SWAPFILE" ]; then
    swapoff "$SWAPFILE" 2>/dev/null || true
    rm -f "$SWAPFILE"
  fi
}

# Si algo peta donde no tocaba, que se vea DÓNDE en vez de morir en silencio
# dejando el panel a medias. Es justo lo que pasó con la versión anterior: una
# copia de una carpeta que ya no existía cortaba el instalador nada más borrar
# el botón viejo, así que el botón desaparecía y no se veía el motivo.
LINEA_ACTUAL="?"
trap 'LINEA_ACTUAL=$LINENO' ERR
al_salir() {
  RC=$?
  cleanup_swap
  if [ "$RC" != "0" ] && [ "$TERMINADO" != "1" ]; then
    echo ""
    echo "    ============================================================="
    echo "    EL INSTALADOR SE HA PARADO (código $RC, línea $LINEA_ACTUAL)."
    echo "    ============================================================="
    echo "    NO se ha desinstalado nada: lo que ya funcionaba sigue igual."
    echo "    Manda estas líneas y se corrige."
  fi
}
TERMINADO=0
trap al_salir EXIT

PANEL="/var/www/pterodactyl"
DO_BUILD=1
SOLO_FRONTEND=0
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    # Rehacer SOLO el botón del cliente y recompilar, sin volver a tocar
    # archivos ni rutas. Es lo que usa install-frontend.sh: si la compilación
    # falla, se reintenta esto y ya, en vez de repetir la instalación entera.
    --solo-frontend) SOLO_FRONTEND=1 ;;
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
# 0) ¿Trae el tema hueco para extensiones?
#
# Un tema preparado (Arix con los huecos) recoge solo lo que se deje en esas
# carpetas: sale la página Y el botón sin tocar routes.ts, sin escribir en la
# base de datos y, sobre todo, SIN INYECTAR NADA.
#
# Si no los trae, se hace como siempre: componente + entrada en routes.ts, y
# un <li> en la plantilla del admin.
# ---------------------------------------------------------------------------
SLOT_CLIENTE="$PANEL/resources/scripts/components/server/extensions"
SLOT_ADMIN="$PANEL/resources/views/admin/extensions"

if [ -d "$SLOT_CLIENTE" ]; then
  USA_SLOT=1
  echo "    Tema con hueco para extensiones: se usará (sin tocar routes.ts)."
else
  USA_SLOT=0
fi

# ---------------------------------------------------------------------------
# 0b) Restos de instalaciones anteriores de ESTA extensión.
#
# OJO CON EL ORDEN. Aquí NO se borra ni el botón del menú de usuario ni el del
# admin: los dos se reescriben enteros más abajo, en los pasos 3 y 4. Si se
# borraran ahora y el instalador se parase por el motivo que fuera, el panel se
# quedaría SIN el botón que ya tenía. Eso es exactamente lo que pasaba antes.
#
# Lo único que se limpia aquí son las marcas del menú del admin, porque esas sí
# se acumulan si se instala dos veces seguidas.
# ---------------------------------------------------------------------------
if grep -q 'PteroBackups NAV' "$PANEL/resources/views/layouts/admin.blade.php" 2>/dev/null; then
  sed -i '/PteroBackups NAV START/,/PteroBackups NAV END/d' "$PANEL/resources/views/layouts/admin.blade.php" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 1) Copiar archivos (controladores, vistas y componentes React)
#
# Se copia SOLO lo que venga en el paquete. Una versión trae unas carpetas y
# otra trae otras: la que quitó los archivos del inyector se quedó sin
# panel/public y "cp" murió ahí mismo, cortando el instalador a mitad. Por eso
# ahora se comprueba antes cada carpeta en vez de darla por hecha.
# ---------------------------------------------------------------------------
if [ "$SOLO_FRONTEND" = "1" ]; then
  # Modo "solo el botón": los archivos ya tienen que estar puestos.
  if [ ! -f "$PANEL/resources/scripts/components/server/pterobackups/PteroBackupsContainer.tsx" ]; then
    echo ""
    echo "    ERROR: la extensión no está instalada en este panel."
    echo "           Lanza primero la instalación completa:"
    echo "             sudo bash $HERE/install.sh $PANEL"
    exit 1
  fi
  echo "    Solo se rehará el botón del cliente y se recompilará."
else
  COPIADAS=0
  for CARPETA in app resources public; do
    if [ -d "$HERE/panel/$CARPETA" ] && [ -n "$(ls -A "$HERE/panel/$CARPETA" 2>/dev/null)" ]; then
      mkdir -p "$PANEL/$CARPETA"
      cp -r "$HERE/panel/$CARPETA/." "$PANEL/$CARPETA/"
      COPIADAS=$((COPIADAS + 1))
    fi
  done

  if [ "$COPIADAS" -eq 0 ]; then
    echo ""
    echo "    ERROR: el paquete no trae la carpeta panel/ con los archivos."
    echo "           ¿Se descomprimió entero? Debe verse así:"
    echo "             extension/install.sh"
    echo "             extension/panel/app/..."
    echo "             extension/panel/resources/..."
    exit 1
  fi

  # Los archivos que de verdad hacen falta. Si alguno no está, mejor parar aquí
  # que dejar el panel con la mitad puesta.
  for IMPRESCINDIBLE in \
    "app/Http/Controllers/PteroBackups/ServerBackupsController.php" \
    "app/Http/Controllers/PteroBackups/AdminController.php" \
    "app/PteroBackups/Client.php" \
    "resources/scripts/components/server/pterobackups/PteroBackupsContainer.tsx" \
    "resources/views/admin/pterobackups/index.blade.php"; do
    if [ ! -f "$PANEL/$IMPRESCINDIBLE" ]; then
      echo ""
      echo "    ERROR: falta $IMPRESCINDIBLE después de copiar."
      echo "           El paquete está incompleto. No se toca nada más."
      exit 1
    fi
  done

  echo "    Archivos copiados y comprobados."
fi

# Restos de la versión anterior, que metía el botón con JavaScript.
rm -f "$PANEL/public/pterobackups/inject.js" "$PANEL/public/pterobackups/admin-inject.js"

# Y la pantalla suelta que abría aquel botón inyectado.
#
# Era una página aparte, con su propio HTML y su propio JavaScript, servida en
# /pterobackups/server/{id}. Ya no la usa nadie: la pantalla buena es la de
# React, la del botón "Backup 2.0". Tenerlas las dos es justo lo que da la
# sensación de que sigue instalada una versión vieja.
rm -rf "$PANEL/resources/views/pterobackups"
rm -f  "$PANEL/public/pterobackups/pb.css"
rmdir  "$PANEL/public/pterobackups" 2>/dev/null || true
for FILE in $(grep -rl 'pterobackups/inject.js\|pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null || true); do
  sed -i '\#pterobackups/inject.js#d;\#pterobackups/admin-inject.js#d' "$FILE" 2>/dev/null || true
  echo "    Limpiada la inyección antigua en $(basename "$FILE")"
done

# ---------------------------------------------------------------------------
# 2) Rutas de la extensión (solo si no estaban ya)
# ---------------------------------------------------------------------------
if [ "$SOLO_FRONTEND" != "1" ]; then
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

fi

# ---------------------------------------------------------------------------
# 3) Botón del ÁREA DE USUARIO: entrada nativa en routes.ts
# ---------------------------------------------------------------------------
ROUTES_TS="$PANEL/resources/scripts/routers/routes.ts"
PATCHER="$HERE/tools/patch-routes.php"

if [ "$USA_SLOT" -eq 1 ]; then
  # Con el hueco del tema basta con dejar la carpeta: el tema la recoge sola al
  # compilar y saca la página y el botón. No se toca routes.ts.
  #
  # Se vacía primero por si una versión anterior dejó ahí archivos con otro
  # nombre; el route.tsx se escribe justo después, en el mismo paso, así que el
  # botón nunca se queda sin él.
  rm -rf "$SLOT_CLIENTE/pterobackups"
  mkdir -p "$SLOT_CLIENTE/pterobackups"
  cat > "$SLOT_CLIENTE/pterobackups/route.tsx" <<'TSXEOF'
import PteroBackupsContainer from '@/components/server/pterobackups/PteroBackupsContainer';

export default {
    path: '/pterobackups',
    permission: 'backup.*',
    name: 'Backup 2.0',
    icon: 'HiOutlineArchive',
    component: PteroBackupsContainer,
};
TSXEOF
  if [ ! -s "$SLOT_CLIENTE/pterobackups/route.tsx" ]; then
    echo "    ERROR: no se pudo escribir en $SLOT_CLIENTE/pterobackups/"
    echo "           Revisa permisos. Sin ese archivo no sale el botón."
    exit 1
  fi
  echo "    OK: botón 'Backup 2.0' puesto en el hueco de extensiones del tema."
elif [ ! -f "$ROUTES_TS" ]; then
  echo "    AVISO: no existe $ROUTES_TS."
  echo "           El botón del área de usuario no se podrá añadir."
  DO_BUILD=0
elif [ ! -f "$PATCHER" ]; then
  echo "    AVISO: falta $PATCHER (¿clonaste el repositorio entero?)."
  DO_BUILD=0
else
  # El parcheo lo hace un script PHP: localiza el array "server: [" contando
  # corchetes (saltándose cadenas y comentarios), mete el bloque entre marcas
  # y guarda una copia del routes.ts original al lado. Así quitarlo después
  # deja el archivo BYTE A BYTE como estaba, sin depender de expresiones.
  set +e
  php "$PATCHER" "$PANEL"
  PATCH_RC=$?
  set -e
  case "$PATCH_RC" in
    0) echo "    OK: botón 'Backup 2.0' registrado en routes.ts" ;;
    2) echo "    El botón de usuario ya estaba registrado en routes.ts." ;;
    *) echo "    AVISO: no se pudo registrar el botón en routes.ts."
       DO_BUILD=0 ;;
  esac
fi

# ---------------------------------------------------------------------------
# 4) Botón del ÁREA DE ADMIN: <li> nativo en la plantilla Blade
#    (esta parte del panel no es React, así que no hay que recompilar nada)
# ---------------------------------------------------------------------------
if [ "$SOLO_FRONTEND" != "1" ]; then
ADMIN_LAYOUT="$PANEL/resources/views/layouts/admin.blade.php"

if [ -d "$SLOT_ADMIN" ]; then
  # El tema trae hueco: se deja el archivo y listo. Sale al momento, sin
  # compilar nada, y al desinstalar basta con borrarlo.
  cat > "$SLOT_ADMIN/pterobackups.blade.php" <<'BLADEEOF'
{{--
    Entrada del menú de PteroBackups.

    El @if NO sobra: si algún día se desinstala la extensión y este archivo se
    queda aquí, route() lanzaría una excepción y el área de administración
    ENTERA daría error 500. Comprobando antes que la ruta existe, lo peor que
    puede pasar es que no salga el botón.
--}}
@if (Route::has('admin.pterobackups'))
    <li class="header">BACKUPS</li>
    <li class="{{ Route::currentRouteNamed('admin.pterobackups*') ? 'active' : '' }}">
        <a href="{{ route('admin.pterobackups') }}">
            <i data-lucide="archive"></i> <i class="fa fa-cloud-download"></i> <span>PteroBackups</span>
        </a>
    </li>
@endif
BLADEEOF
  echo "    OK: botón 'PteroBackups' puesto en el hueco de admin del tema."
elif [ ! -f "$ADMIN_LAYOUT" ]; then
  echo "    AVISO: no existe $ADMIN_LAYOUT (el menú de admin no se tocará)."
elif grep -q 'PteroBackups NAV' "$ADMIN_LAYOUT"; then
  echo "    El botón de admin ya estaba en el menú."
else
  NAV=$(cat <<'BLADEEOF'
                    {{-- PteroBackups NAV START (gestionado por extension/install.sh) --}}
                    @if (Route::has('admin.pterobackups'))
                    <li class="{{ Route::currentRouteNamed('admin.pterobackups*') ? 'active' : '' }}">
                        <a href="{{ route('admin.pterobackups') }}">
                            <i data-lucide="archive"></i> <i class="fa fa-cloud-download"></i> <span>PteroBackups</span>
                        </a>
                    </li>
                    @endif
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

fi

# ---------------------------------------------------------------------------
# 5) Recompilar el panel (solo por el botón del área de usuario)
# ---------------------------------------------------------------------------
BUILD_OK=0
STAMP="$(date +%Y%m%d-%H%M%S)"
BUILD_LOG="$PANEL/storage/logs/pterobackups-build-$STAMP.log"
ASSETS_BACKUP="$PANEL/storage/pterobackups-assets-$STAMP"

# Deshace la entrada del menú de usuario, dejando routes.ts como estaba.
# El patcher restaura desde la copia del original que guardó al instalar.
revert_routes_ts() {
  [ -f "$ROUTES_TS" ] || return 0
  [ -f "$PATCHER" ] || return 0
  php "$PATCHER" "$PANEL" --remove >/dev/null 2>&1 || true
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

if [ "$DO_BUILD" = "1" ]; then
  # Gestor de paquetes: yarn si está, npm si no.
  if command -v yarn >/dev/null 2>&1; then
    PKG=yarn
  elif command -v npm >/dev/null 2>&1; then
    PKG=npm
    echo "    yarn no está instalado: se usará npm (tarda más)."
  else
    PKG=""
  fi

  if [ -z "$PKG" ]; then
    echo ""
    echo "    AVISO: no hay ni yarn ni npm, así que no se puede recompilar."
    echo "           El área de admin ya funciona; para que salga el botón en el"
    echo "           menú de los usuarios, instala yarn y vuelve a lanzarme:"
    echo "             npm install -g yarn"
    revert_routes_ts
    echo "    (La entrada de routes.ts se ha quitado para no dejarla a medias.)"
  elif ! command -v node >/dev/null 2>&1; then
    echo ""
    echo "    AVISO: no está instalado node, así que no se puede recompilar."
    revert_routes_ts
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
    # Mismos umbrales que usa DNS Reverse, que es la que compila bien en tu
    # servidor: se añade swap en cuanto hay menos de 2200 MB libres y menos de
    # 2000 MB de swap, y si "fallocate" no funciona (pasa en algunos VPS y en
    # contenedores) se cae a "dd", que funciona en todas partes.
    MEM_FREE=$(free -m 2>/dev/null | awk '/^Mem:/ {print ($7 != "" && $7 != 0 ? $7 : $4)}')
    MEM_FREE=${MEM_FREE:-2048}
    SWAP_TOTAL=$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}')
    SWAP_TOTAL=${SWAP_TOTAL:-0}

    if [ "$MEM_FREE" -lt 2200 ] && [ "$SWAP_TOTAL" -lt 2000 ] \
       && [ "${PTEROBACKUPS_SIN_SWAP:-0}" != "1" ] \
       && command -v mkswap >/dev/null 2>&1 && [ ! -e "$SWAPFILE" ]; then
      echo "    Solo hay ${MEM_FREE} MB de RAM libre: se añade swap temporal de 4 GB."
      if (fallocate -l 4G "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count=4096 status=none 2>/dev/null) \
         && chmod 600 "$SWAPFILE" && mkswap "$SWAPFILE" >/dev/null 2>&1 && swapon "$SWAPFILE" 2>/dev/null; then
        echo "    Swap temporal activada (se quita sola al terminar)."
        MEM_FREE=$((MEM_FREE + 4096))
      else
        cleanup_swap
        echo "    No se pudo crear la swap (¿contenedor?). Se compila con lo que hay."
      fi
    fi

    NODE_MEM=$((MEM_FREE * 75 / 100))
    [ "$NODE_MEM" -lt 1536 ] && NODE_MEM=1536
    [ "$NODE_MEM" -gt 4096 ] && NODE_MEM=4096
    echo "    Memoria para node: ${NODE_MEM} MB (libre: ${MEM_FREE} MB, swap: ${SWAP_TOTAL} MB)"

    # Compilar necesita sitio: se rehace public/assets entero. Si el disco está
    # lleno, webpack muere sin decir por qué y el panel se queda sin frontend.
    DISCO_LIBRE_MB=$(df -Pm "$PANEL" 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "${DISCO_LIBRE_MB:-}" ] && [ "$DISCO_LIBRE_MB" -lt 1024 ]; then
      echo ""
      echo "    AVISO: solo quedan ${DISCO_LIBRE_MB} MB libres en el disco."
      echo "           Compilar necesita cerca de 1 GB. Si falla, es por esto:"
      echo "             df -h $PANEL"
    fi

    # Los paneles 1.14/1.15 compilan con webpack 5, que NO necesita
    # --openssl-legacy-provider. Solo se activa si el panel trae webpack 4.
    EXTRA_NODE_OPTS=""
    NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "${NODE_MAJOR:-0}" -ge 17 ] && grep -q '"webpack": *"\^\?4' "$PANEL/package.json" 2>/dev/null; then
      EXTRA_NODE_OPTS="--openssl-legacy-provider"
      echo "    webpack 4 con node moderno: se activa --openssl-legacy-provider"
    fi

    echo "==> Recompilando el panel (tarda varios minutos, no lo interrumpas)..."
    mkdir -p "$(dirname "$BUILD_LOG")"
    cd "$PANEL"

    # Las dependencias solo se descargan si faltan: volver a lanzarlas en un
    # panel con tema ya montado es lento y puede fallar por red sin motivo.
    if [ -d "$PANEL/node_modules/webpack" ]; then
      echo "    node_modules ya estaba (se salta la descarga)."
      DEPS_CMD="true"
    elif [ "$PKG" = "yarn" ]; then
      DEPS_CMD="yarn install --network-timeout 600000"
    else
      DEPS_CMD="npm install --no-audit --no-fund"
    fi
    if [ "$PKG" = "yarn" ]; then BUILD_CMD="yarn build:production"; else BUILD_CMD="npm run build:production"; fi

    set +e
    NODE_OPTIONS="--max-old-space-size=$NODE_MEM $EXTRA_NODE_OPTS" \
      sh -c "$DEPS_CMD && $BUILD_CMD" > "$BUILD_LOG" 2>&1
    BUILD_RC=$?
    set -e

    if [ "$BUILD_RC" = "0" ] && frontend_ok; then
      BUILD_OK=1
      cleanup_swap
      echo "    Panel recompilado y frontend verificado."
      # La copia de seguridad ya no hace falta, y cada una ocupa lo que pese
      # public/assets. Se guardan las 3 últimas por si acaso y se borran las
      # viejas, para no ir llenando el disco a cada instalación.
      ls -1dt "$PANEL/storage/pterobackups-assets-"* 2>/dev/null | tail -n +4 | while read -r VIEJA; do
        rm -rf "$VIEJA"
      done
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
      if grep -qiE "heap out of memory|Allocation failed|Killed|JavaScript heap|signal SIGKILL" "$BUILD_LOG" \
         || [ "$BUILD_RC" = "137" ]; then
        echo "    CAUSA: se quedó SIN MEMORIA (el sistema mató la compilación)."
        echo "    Solución: añade swap permanente y vuelve a lanzar el instalador:"
        echo "      fallocate -l 4G /swapfile && chmod 600 /swapfile && \\"
        echo "        mkswap /swapfile && swapon /swapfile && \\"
        echo "        echo '/swapfile none swap sw 0 0' >> /etc/fstab"
      elif grep -qiE "ENOSPC|no space left on device" "$BUILD_LOG"; then
        echo "    CAUSA: se quedó SIN ESPACIO EN DISCO."
        echo "    Mira cuánto queda y libera sitio:"
        echo "      df -h $PANEL"
      elif grep -q "ERROR in" "$BUILD_LOG"; then
        echo "    Errores de compilación encontrados:"
        grep -A3 "ERROR in" "$BUILD_LOG" | head -n 30 | sed 's/^/      /'
      else
        # Ni errores de webpack ni causa conocida: webpack se cortó sin decir
        # nada. Aquí NO se filtra el registro, porque filtrando se quedaba en
        # blanco y no había forma de saber qué pasó.
        echo "    webpack no dejó ningún error: se cortó de golpe."
        echo "    Suele ser falta de memoria o de disco. Situación de la máquina:"
        free -m 2>/dev/null | sed 's/^/      /'
        df -Ph "$PANEL" 2>/dev/null | sed 's/^/      /'
        echo ""
        echo "    Últimas líneas del registro tal cual:"
        tail -n 25 "$BUILD_LOG" | sed 's/^/      /'
      fi
      echo "    -------------------------------------------------------------"
      echo "    Registro completo: $BUILD_LOG"
      echo "    -------------------------------------------------------------"
      # VUELTA ATRÁS: el frontend que había vuelve tal cual, así que el panel NO
      # se queda en blanco.
      restore_assets
      if [ "$USA_SLOT" -eq 1 ]; then
        # Con el hueco del tema no se ha tocado ningún archivo del panel: el
        # botón es una carpeta aparte. Se deja puesta para que salga en cuanto
        # se compile bien, sin tener que reinstalar nada.
        echo "    El botón está preparado y saldrá en cuanto compile. Reintenta con:"
        echo "      cd $PANEL && yarn build:production"
      else
        revert_routes_ts
        echo "    Entrada de routes.ts retirada (el archivo queda como estaba)."
      fi
      echo "    El área de admin y la página siguen instaladas y funcionando."
      echo "    ============================================================="
    fi
  fi
else
  echo ""
  echo "    Recompilación omitida (--no-build)."
  if [ "$USA_SLOT" -eq 1 ]; then
    echo "    El botón del menú de usuario ya está preparado, pero no saldrá"
    echo "    hasta que compiles:"
    echo "      cd $PANEL && yarn build:production"
  else
    revert_routes_ts
    echo "    La entrada de routes.ts se ha quitado para no dejar el panel a medias."
    echo "    El área de admin funciona ya. Para el botón del menú de usuario,"
    echo "    vuelve a ejecutar el instalador SIN --no-build."
  fi
fi

# ---------------------------------------------------------------------------
# 5b) Tema Arix: su menú lateral NO sale de routes.ts, sino de una lista de
#     enlaces guardada en la base de datos. Añadimos ahí la entrada (eso no
#     necesita recompilar). Solo tiene sentido si la página existe, o sea si
#     el panel se llegó a compilar con la ruta dentro.
# ---------------------------------------------------------------------------
if [ "$USA_SLOT" -eq 1 ]; then
  # Con el hueco, el botón sale del hueco. Si además quedó apuntado en la lista
  # de enlaces de Arix de una instalación anterior, habría DOS fuentes para el
  # mismo botón: o sale repetido, o el tema se queda con el de la lista y el
  # del hueco no se pinta. Se quita el de la lista para que solo haya una.
  if [ -d "$PANEL/app/Http/Controllers/Admin/Arix" ] || [ -f "$PANEL/config/arixTheme.php" ]; then
    if (cd "$PANEL" && php artisan pterobackups:arix-link --status) >/dev/null 2>&1; then
      (cd "$PANEL" && php artisan pterobackups:arix-link --remove) >/dev/null 2>&1 \
        && echo "    Quitada la entrada vieja de la lista de enlaces de Arix (ya sobra)."
    fi
  fi
  echo "    El tema recoge el botón de su hueco: no hace falta tocar su lista de enlaces."
elif [ -d "$PANEL/app/Http/Controllers/Admin/Arix" ] || [ -f "$PANEL/config/arixTheme.php" ]; then
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

# ---------------------------------------------------------------------------
# 7) COMPROBACIÓN FINAL DEL BOTÓN
#
# Antes el instalador terminaba diciendo "instalada correctamente" aunque el
# botón no hubiese llegado a ninguna parte. Ahora se mira de verdad: primero
# que el archivo del botón esté puesto, y luego que haya acabado DENTRO del
# frontend compilado. Si no está, se dice claramente y con qué arreglarlo.
# ---------------------------------------------------------------------------
BOTON_OK=0
BOTON_MOTIVO=""
BOTON_ARREGLO="cd $PANEL && yarn build:production"

if [ "$USA_SLOT" -eq 1 ]; then
  if [ ! -s "$SLOT_CLIENTE/pterobackups/route.tsx" ]; then
    BOTON_MOTIVO="no se llegó a crear el archivo del botón"
    BOTON_ARREGLO="sudo bash $HERE/install.sh $PANEL"
  elif [ "$DO_BUILD" != "1" ]; then
    BOTON_MOTIVO="falta compilar el panel (usaste --no-build)"
  elif [ "$BUILD_OK" != "1" ]; then
    BOTON_MOTIVO="la recompilación no terminó bien (mira el registro de arriba)"
  elif grep -rlq "Backup 2\.0" "$PANEL/public/assets/" 2>/dev/null; then
    BOTON_OK=1
  else
    BOTON_MOTIVO="compiló, pero el botón no aparece dentro del frontend"
  fi
elif [ "$BUILD_OK" = "1" ] && grep -rlq "Backup 2\.0" "$PANEL/public/assets/" 2>/dev/null; then
  BOTON_OK=1
elif [ "$DO_BUILD" != "1" ]; then
  # Sin el hueco del tema, --no-build deja routes.ts como estaba a propósito,
  # así que compilar por tu cuenta no bastaría: hay que repetir el instalador.
  BOTON_MOTIVO="usaste --no-build, y sin el hueco del tema eso deshace la entrada"
  BOTON_ARREGLO="sudo bash $HERE/install.sh $PANEL"
else
  BOTON_MOTIVO="la recompilación no terminó bien (mira el registro de arriba)"
  BOTON_ARREGLO="sudo bash $HERE/install.sh $PANEL"
fi

TERMINADO=1

echo ""
echo "=========================================================="
echo " Extensión PteroBackups instalada."
echo ""
if [ "$BOTON_OK" = "1" ]; then
  echo " Botón 'Backup 2.0' del área de cliente:  PUESTO Y COMPILADO"
  echo " (si no lo ves, recarga con Ctrl+F5: es la caché del navegador)"
else
  echo " Botón 'Backup 2.0' del área de cliente:  TODAVÍA NO SALE"
  echo "   Motivo: $BOTON_MOTIVO"
  echo "   Para terminarlo:"
  echo "     $BOTON_ARREGLO"
  echo "   Y comprueba cómo quedó con:"
  echo "     sudo bash $HERE/check.sh $PANEL"
fi
echo ""
echo " Siguientes pasos:"
echo "  1. Entra a  https://TU-PANEL/admin/pterobackups"
echo "     (también aparece 'PteroBackups' en el menú del admin)"
echo "  2. Pega la URL del sistema de copias y la clave de API."
echo "     Ambos están en el sistema: Configuración -> Extensión del panel."
echo "  3. Guarda: la conexión se prueba automáticamente."
echo ""
echo " Para desinstalarla del todo:"
echo "     sudo bash $HERE/uninstall.sh $PANEL"
echo "=========================================================="
