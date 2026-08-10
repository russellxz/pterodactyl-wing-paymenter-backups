#!/bin/bash
# Comprobador de la extensión PteroBackups.
# Muestra un informe completo para diagnosticar por qué no aparece el botón.
# Uso:   sudo bash check.sh [/ruta/del/panel]

PANEL="${1:-/var/www/pterodactyl}"

echo "================ Comprobación PteroBackups ================"

if [ ! -f "$PANEL/artisan" ]; then
  echo "ERROR: no se encontró el panel en $PANEL"
  echo "Uso: sudo bash check.sh /ruta/del/panel"
  exit 1
fi

SLOT_CLIENTE="$PANEL/resources/scripts/components/server/extensions"
ROUTES_TS="$PANEL/resources/scripts/routers/routes.ts"

echo ""
echo "[1] Archivos de la extensión:"
[ -d "$PANEL/app/Http/Controllers/PteroBackups" ] && echo "    controladores      OK" || echo "    controladores      FALTAN -> corre install.sh"
[ -f "$PANEL/app/PteroBackups/Client.php" ]       && echo "    cliente del API    OK" || echo "    cliente del API    FALTA  -> corre install.sh"
[ -f "$PANEL/resources/scripts/components/server/pterobackups/PteroBackupsContainer.tsx" ] \
  && echo "    pantalla React     OK" || echo "    pantalla React     FALTA  -> corre install.sh"
[ -f "$PANEL/resources/views/admin/pterobackups/index.blade.php" ] \
  && echo "    pantalla de admin  OK" || echo "    pantalla de admin  FALTA  -> corre install.sh"

echo ""
echo "[2] Botón 'Backup 2.0' del ÁREA DE CLIENTE:"

# Los dos caminos posibles. Con un tema preparado (Arix con huecos) el botón es
# un archivo aparte; sin él, es una entrada dentro de routes.ts.
PUESTO=0
if [ -f "$SLOT_CLIENTE/pterobackups/route.tsx" ]; then
  echo "    método: hueco de extensiones del tema"
  echo "    archivo del botón        OK"
  REFERENCIA="$SLOT_CLIENTE/pterobackups/route.tsx"
  PUESTO=1
elif [ -d "$SLOT_CLIENTE" ]; then
  echo "    método: hueco de extensiones del tema"
  echo "    archivo del botón        FALTA"
  echo "                             -> $SLOT_CLIENTE/pterobackups/route.tsx"
  echo "                             -> corre: sudo bash install.sh $PANEL"
elif [ ! -f "$ROUTES_TS" ]; then
  echo "    no existe $ROUTES_TS"
elif grep -q 'pterobackups:inicio' "$ROUTES_TS"; then
  echo "    método: entrada en routes.ts"
  echo "    registrado en routes.ts  OK"
  REFERENCIA="$ROUTES_TS"
  PUESTO=1
elif grep -q 'PteroBackupsContainer' "$ROUTES_TS"; then
  echo "    registrado con marcas ANTIGUAS -> desinstala y vuelve a instalar"
else
  echo "    NO registrado -> corre: sudo bash install.sh $PANEL"
fi

# Aunque el archivo esté puesto, el botón NO sale hasta que el panel se
# recompila. Esto es lo que de verdad decide si se ve o no.
if [ "$PUESTO" = "1" ]; then
  if ! ls "$PANEL/public/assets/"*.js >/dev/null 2>&1; then
    echo "    frontend compilado       NO HAY public/assets"
    echo "                             -> cd $PANEL && yarn build:production"
  elif grep -rlq "Backup 2\.0" "$PANEL/public/assets/" 2>/dev/null; then
    echo "    dentro del frontend      OK  <- el botón DEBE verse"
    echo "                             (si no lo ves, recarga con Ctrl+F5)"
  else
    echo "    dentro del frontend      NO  <- por eso no sale el botón"
    echo "                             -> cd $PANEL && yarn build:production"
    BUILT=$(ls -t "$PANEL/public/assets/"*.js 2>/dev/null | head -n1)
    if [ -n "$BUILT" ] && [ -n "$REFERENCIA" ] && [ "$REFERENCIA" -nt "$BUILT" ]; then
      echo "                             (el frontend es más viejo que el botón)"
    fi
  fi
fi

echo ""
echo "[3] Botón del ÁREA DE ADMIN (Blade, no necesita recompilar):"
if [ -f "$PANEL/resources/views/admin/extensions/pterobackups.blade.php" ]; then
  echo "    en el hueco de admin     OK"
elif grep -q 'PteroBackups NAV' "$PANEL/resources/views/layouts/admin.blade.php" 2>/dev/null; then
  echo "    en la plantilla de admin OK"
else
  echo "    NO está -> corre install.sh, o entra a /admin/pterobackups directamente"
fi

echo ""
echo "[3b] Tema Arix (su menú puede salir de la base de datos):"
if [ -d "$PANEL/app/Http/Controllers/Admin/Arix" ] || [ -f "$PANEL/config/arixTheme.php" ]; then
  echo "    Arix detectado."
  if [ -d "$SLOT_CLIENTE" ]; then
    echo "    trae hueco de extensiones: el botón sale del hueco, no de la BD."
    # Si además está en la lista de la BD saldría DOS veces.
    if (cd "$PANEL" && php artisan pterobackups:arix-link --status >/dev/null 2>&1); then
      echo "    AVISO: también está en la lista de enlaces de Arix."
      echo "           Quítalo para que no salga repetido:"
      echo "             cd $PANEL && php artisan pterobackups:arix-link --remove"
    fi
  elif (cd "$PANEL" && php artisan pterobackups:arix-link --status >/dev/null 2>&1); then
    echo "    botón en el menú de Arix   OK"
  else
    echo "    botón en el menú de Arix   NO -> corre: cd $PANEL && php artisan pterobackups:arix-link"
  fi
else
  echo "    Arix no está instalado (se usa el menú normal del panel)."
fi

echo ""
echo "[4] Rutas instaladas:"
grep -q 'PteroBackups START' "$PANEL/routes/base.php" 2>/dev/null && echo "    base.php  OK" || echo "    base.php  SIN RUTAS -> corre install.sh"
grep -q 'PteroBackups START' "$PANEL/routes/admin.php" 2>/dev/null && echo "    admin.php OK" || echo "    admin.php SIN RUTAS -> corre install.sh"

echo ""
echo "[4b] Ruta comodín de React (debe dejar pasar /pterobackups):"
grep -q 'api|auth|admin|daemon|pterobackups' "$PANEL/routes/base.php" 2>/dev/null && echo "    OK" || echo "    SIN AJUSTAR -> corre: sudo bash install.sh"

echo ""
echo "[5] Restos de la versión antigua (la que inyectaba JavaScript):"
RESTOS=0
LEFT=$(grep -rl 'pterobackups/inject.js\|pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null || true)
if [ -n "$LEFT" ]; then
  echo "    QUEDAN scripts inyectados (vuelve a correr install.sh):"
  echo "$LEFT" | sed 's/^/      /'
  RESTOS=1
fi
[ -e "$PANEL/public/pterobackups/inject.js" ]      && { echo "    queda public/pterobackups/inject.js"; RESTOS=1; }
[ -e "$PANEL/public/pterobackups/admin-inject.js" ] && { echo "    queda public/pterobackups/admin-inject.js"; RESTOS=1; }
[ -d "$PANEL/resources/views/pterobackups" ]        && { echo "    queda la pantalla suelta resources/views/pterobackups"; RESTOS=1; }
[ "$RESTOS" = "0" ] && echo "    ninguno  OK"

echo ""
echo "[6] Limpiando caché de vistas por si acaso..."
cd "$PANEL" && php artisan view:clear >/dev/null 2>&1 && echo "    Caché de vistas limpiada." || echo "    No se pudo limpiar (no es grave)."

echo ""
echo "==========================================================="
echo " Si el botón sigue sin salir, manda una captura de TODO"
echo " este resultado para diagnosticarlo."
echo "==========================================================="
