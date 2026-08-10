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

echo ""
echo "[1] Archivos de la extensión:"
[ -f "$PANEL/public/pterobackups/pb.css" ] && echo "    estilos            OK" || echo "    estilos            FALTAN -> corre install.sh"
[ -d "$PANEL/app/Http/Controllers/PteroBackups" ] && echo "    controladores      OK" || echo "    controladores      FALTAN -> corre install.sh"
[ -d "$PANEL/resources/scripts/components/server/pterobackups" ] && echo "    componente React   OK" || echo "    componente React   FALTA  -> corre install.sh"

echo ""
echo "[2] Botón del ÁREA DE USUARIO (entrada nativa en routes.ts):"
ROUTES_TS="$PANEL/resources/scripts/routers/routes.ts"
if [ ! -f "$ROUTES_TS" ]; then
  echo "    no existe $ROUTES_TS"
elif grep -q 'pterobackups:inicio' "$ROUTES_TS"; then
  echo "    registrado en routes.ts  OK"
  # El botón solo aparece si el panel se recompiló DESPUÉS de registrarlo.
  BUILT=$(ls -t "$PANEL/public/assets/"*.js 2>/dev/null | head -n1)
  if [ -n "$BUILT" ]; then
    if [ "$BUILT" -nt "$ROUTES_TS" ]; then
      echo "    panel recompilado        OK"
    else
      echo "    panel recompilado        NO -> el botón no saldrá hasta que hagas:"
      echo "                                  cd $PANEL && yarn build:production"
    fi
  else
    echo "    no se encontró public/assets: ¿compilaste el panel alguna vez?"
  fi
elif grep -q 'PteroBackupsContainer' "$ROUTES_TS"; then
  echo "    registrado con marcas ANTIGUAS -> desinstala y vuelve a instalar"
else
  echo "    NO registrado -> corre: sudo bash install.sh"
  echo "    (si el build falló, el instalador lo quita a propósito para no"
  echo "     dejar un botón que lleve a una página que no existe)"
fi

echo ""
echo "[3] Botón del ÁREA DE ADMIN (bloque Blade, no necesita recompilar):"
grep -q 'PteroBackups NAV' "$PANEL/resources/views/layouts/admin.blade.php" 2>/dev/null \
  && echo "    en el menú de admin      OK" \
  || echo "    NO está -> corre install.sh, o entra a /admin/pterobackups directamente"

echo ""
echo "[3b] Tema Arix (su menú sale de la base de datos, no de routes.ts):"
if [ -d "$PANEL/app/Http/Controllers/Admin/Arix" ] || [ -f "$PANEL/config/arixTheme.php" ]; then
  echo "    Arix detectado."
  if (cd "$PANEL" && php artisan pterobackups:arix-link --status >/dev/null 2>&1); then
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
echo "[5] Restos de la versión antigua (inyección por JavaScript):"
LEFT=$(grep -rl 'pterobackups/inject.js\|pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null || true)
if [ -n "$LEFT" ]; then
  echo "    QUEDAN restos (vuelve a correr install.sh para limpiarlos):"
  echo "$LEFT" | sed 's/^/      /'
else
  echo "    ninguno  OK"
fi

echo ""
echo "[6] Limpiando caché de vistas por si acaso..."
cd "$PANEL" && php artisan view:clear >/dev/null 2>&1 && echo "    Caché de vistas limpiada." || echo "    No se pudo limpiar (no es grave)."

echo ""
echo "==========================================================="
echo " Si el botón sigue sin salir, manda una captura de TODO"
echo " este resultado para diagnosticarlo."
echo "==========================================================="
