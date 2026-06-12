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
echo "[1] Archivos públicos (deben salir 3: inject.js, admin-inject.js, pb.css):"
ls -1 "$PANEL/public/pterobackups" 2>/dev/null || echo "    FALTAN -> corre: sudo bash install.sh"

echo ""
echo "[2] Plantillas con el script de USUARIO inyectado:"
grep -rl 'pterobackups/inject.js' "$PANEL/resources/views" 2>/dev/null | grep -v 'views/pterobackups' || echo "    NINGUNA -> corre: sudo bash install.sh"

echo ""
echo "[3] Plantillas con el script de ADMIN inyectado:"
grep -rl 'pterobackups/admin-inject.js' "$PANEL/resources/views" 2>/dev/null || echo "    NINGUNA"

echo ""
echo "[4] Rutas instaladas:"
grep -q 'PteroBackups START' "$PANEL/routes/base.php" 2>/dev/null && echo "    base.php  OK" || echo "    base.php  SIN RUTAS -> corre install.sh"
grep -q 'PteroBackups START' "$PANEL/routes/admin.php" 2>/dev/null && echo "    admin.php OK" || echo "    admin.php SIN RUTAS -> corre install.sh"

echo ""
echo "[4b] Ruta comodín de React (debe dejar pasar /pterobackups):"
grep -q 'api|auth|admin|daemon|pterobackups' "$PANEL/routes/base.php" 2>/dev/null && echo "    OK" || echo "    SIN AJUSTAR -> corre: sudo bash install.sh"

echo ""
echo "[5] TODAS las plantillas de página que tiene el panel (con </body>):"
grep -rl '</body>' "$PANEL/resources/views" 2>/dev/null | grep -vi 'mail\|vendor\|pterobackups' || echo "    (ninguna encontrada)"

echo ""
echo "[6] Limpiando caché de vistas por si acaso..."
cd "$PANEL" && php artisan view:clear >/dev/null 2>&1 && echo "    Caché de vistas limpiada." || echo "    No se pudo limpiar (no es grave)."

echo ""
echo "==========================================================="
echo " Si el botón sigue sin salir, manda una captura de TODO"
echo " este resultado para diagnosticarlo."
echo "==========================================================="
