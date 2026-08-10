#!/bin/bash
# ============================================================================
# PteroBackups - rehacer SOLO el botón del área de cliente.
#
#   sudo bash install-frontend.sh [/ruta/del/panel]
#   (por defecto usa /var/www/pterodactyl)
#
# Para cuando la extensión ya está instalada y funcionando por el lado del
# admin, pero el botón "Backup 2.0" no sale en el menú de los clientes porque
# la recompilación falló (poca memoria, disco lleno, se cortó la conexión...).
#
# No vuelve a copiar archivos ni a tocar rutas: solo pone el botón donde toque
# y recompila el panel, con la misma red de seguridad de siempre (si el build
# falla, el frontend anterior vuelve tal cual y el panel NO se queda en blanco).
#
# Es lo mismo que:  sudo bash install.sh --solo-frontend
# ============================================================================
AQUI="$(cd "$(dirname "$0")" && pwd)"
exec bash "$AQUI/install.sh" "$@" --solo-frontend
