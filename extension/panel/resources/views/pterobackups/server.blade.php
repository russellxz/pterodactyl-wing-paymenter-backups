<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Backup 2.0 · {{ $server->name }}</title>
    <link rel="stylesheet" href="/pterobackups/pb.css">
</head>
<body>
<div class="pb-wrap">
    <header class="pb-head">
        <div>
            <h1>Backup 2.0</h1>
            <p class="pb-muted">Servidor: <b>{{ $server->name }}</b></p>
        </div>
        <a class="pb-btn" href="/server/{{ $short }}">&larr; Volver al servidor</a>
    </header>

    @if (!$configured)
    <div class="pb-card pb-empty">
        El administrador todavía no ha conectado el sistema de copias. Si crees que es un error, contáctalo.
    </div>
    @else

    <div class="pb-card pb-next" id="pb-next" hidden>
        <div class="pb-next-row">
            <span class="pb-next-ico">&#128338;</span>
            <div>
                <div class="pb-next-label">Próxima copia automática</div>
                <div class="pb-next-value" id="pb-next-value">—</div>
            </div>
        </div>
    </div>

    <div class="pb-card pb-job" id="pb-job" hidden>
        <div class="pb-job-head">
            <span class="pb-spinner"></span>
            <b id="pb-job-name">Restaurando tu servidor</b>
            <span class="pb-count" id="pb-job-count"></span>
        </div>
        <div class="pb-progress"><div class="pb-bar" id="pb-job-bar" style="width:0%"></div></div>
        <p class="pb-muted pb-small" id="pb-job-msg" style="margin-top:8px"></p>
    </div>

    <div class="pb-card">
        <h2>Copias disponibles de tu servidor</h2>
        <p class="pb-muted pb-small">Descarga cualquier copia o restáurala a tu servidor. Al restaurar te preguntaremos si quieres vaciar los archivos actuales antes.</p>
        <div id="pb-list"><p class="pb-muted">Cargando copias...</p></div>
    </div>

    <script>
    (function () {
        'use strict';
        var BASE = '/pterobackups/server/{{ $short }}';
        var CSRF = '{{ csrf_token() }}';
        var MY_UUID = '{{ $server->uuid }}';
        var restoring = false;
        var wasRestoring = false;

        function esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }

        function fmtSize(b) {
            b = Number(b) || 0;
            if (b < 1024) return b + ' B';
            if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
            if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
            return (b / 1073741824).toFixed(2) + ' GB';
        }

        // Lee la respuesta con cuidado: si no es JSON (sesion caducada =
        // pagina HTML 419/500), da un mensaje claro en vez de romper.
        function readJson(r) {
            return r.text().then(function (t) {
                try {
                    return JSON.parse(t);
                } catch (e) {
                    if (r.status === 403 || r.status === 429) {
                        return { ok: false, message: 'Cloudflare bloqueó la petición. Avisa al administrador para que ajuste la protección de bots, o inténtalo de nuevo en un momento.' };
                    }
                    if (r.status === 419) {
                        return { ok: false, message: 'Tu sesión expiró. Recarga la página (F5) e inténtalo de nuevo.' };
                    }
                    return { ok: false, message: 'El servidor respondió de forma inesperada (código ' + r.status + '). Recarga la página e inténtalo de nuevo.' };
                }
            });
        }

        function loadList() {
            fetch(BASE + '/list', { headers: { 'Accept': 'application/json' } })
                .then(readJson)
                .then(function (d) {
                    var box = document.getElementById('pb-list');
                    if (!d.ok) { box.innerHTML = '<p class="pb-muted">' + esc(d.message || 'Error al cargar.') + '</p>'; return; }
                    if (!d.rows || !d.rows.length) {
                        box.innerHTML = '<p class="pb-muted">Tu servidor todavía no tiene copias. Se crearán automáticamente según la programación del administrador.</p>';
                        return;
                    }
                    var html = '<table class="pb-table"><thead><tr><th>Fecha de la copia</th><th>Tamaño</th><th class="pb-actions-h">Acciones</th></tr></thead><tbody>';
                    d.rows.forEach(function (b) {
                        html += '<tr>' +
                            '<td><b>' + esc(b.snapshot_date || b.created_at) + '</b></td>' +
                            '<td>' + fmtSize(b.size) + '</td>' +
                            '<td class="pb-actions">' +
                            '<a class="pb-btn pb-btn-sm" href="' + BASE + '/download/' + b.id + '">Descargar</a> ' +
                            '<button class="pb-btn pb-btn-sm pb-btn-warn" onclick="pbRestore(' + b.id + ')">Restaurar</button>' +
                            '</td></tr>';
                    });
                    html += '</tbody></table>';
                    box.innerHTML = html;
                })
                .catch(function () {});
        }

        window.pbRestore = function (id, _retried) {
            if (restoring) { alert('Ya hay una restauración en curso para tu servidor. Espera a que termine.'); return; }
            if (!_retried) {
                if (!confirm('¿Restaurar esta copia a tu servidor? Los archivos de la copia sobrescribirán los actuales.')) return;
                window._pbWipe = confirm('¿Quieres VACIAR los archivos actuales antes de restaurar?\n\nAceptar = vaciar y restaurar limpio.\nCancelar = restaurar encima de los archivos actuales.');
            }
            fetch(BASE + '/restore/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': CSRF, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                credentials: 'same-origin',
                body: JSON.stringify({ wipe: window._pbWipe })
            })
                .then(function (r) {
                    if ((r.status === 403 || r.status === 429) && !_retried) {
                        return new Promise(function (res) {
                            setTimeout(function () { window.pbRestore(id, true); res(null); }, 1200);
                        });
                    }
                    return readJson(r);
                })
                .then(function (d) {
                    if (d === null) return;
                    if (!d.ok) { alert('No se pudo iniciar: ' + (d.message || 'error')); return; }
                    pollJob();
                })
                .catch(function (e) { alert('Error: ' + e.message); });
        };

        function fmtCountdown(ms) {
            if (ms <= 0) return 'en cualquier momento';
            var s = Math.floor(ms / 1000);
            var d = Math.floor(s / 86400); s -= d * 86400;
            var h = Math.floor(s / 3600); s -= h * 3600;
            var m = Math.floor(s / 60);
            var parts = [];
            if (d) parts.push(d + 'd');
            if (h || d) parts.push(h + 'h');
            parts.push(m + 'm');
            return 'en ' + parts.join(' ');
        }

        // Solo nos interesa el progreso si la tarea es de NUESTRO servidor.
        // Para los usuarios no mostramos copias globales ni de otros.
        function jobIsMine(j) {
            if (!j || !j.active) return false;
            var hay = (String(j.target_uuid || '') === MY_UUID) ||
                      (String(j.server_uuid || '') === MY_UUID) ||
                      (j.message && j.message.indexOf(MY_UUID) !== -1);
            return !!hay;
        }

        function renderJob(j) {
            // Contador de proxima copia
            var nextCard = document.getElementById('pb-next');
            if (j && j.next_run) {
                var now = (j.server_now || Date.now());
                document.getElementById('pb-next-value').textContent = fmtCountdown(j.next_run - now);
                nextCard.hidden = false;
            } else {
                nextCard.hidden = true;
            }

            // Barra de progreso SOLO si la restauracion es de este servidor
            var card = document.getElementById('pb-job');
            var mine = jobIsMine(j);
            if (!mine) {
                card.hidden = true;
                if (wasRestoring) { wasRestoring = false; restoring = false; loadList(); }
                return;
            }
            restoring = true;
            wasRestoring = true;
            card.hidden = false;
            document.getElementById('pb-job-msg').textContent = j.message || '';
            var bar = document.getElementById('pb-job-bar');
            var count = document.getElementById('pb-job-count');
            if (j.total > 0) {
                count.textContent = j.current + ' / ' + j.total;
                bar.style.width = Math.min(100, Math.round((j.current / j.total) * 100)) + '%';
            } else {
                count.textContent = '';
                bar.style.width = '40%';
            }
        }

        function pollJob() {
            fetch(BASE + '/job', { headers: { 'Accept': 'application/json' } })
                .then(readJson)
                .then(renderJob)
                .catch(function () {});
        }

        loadList();
        pollJob();
        setInterval(pollJob, 4000);
    })();
    </script>
    @endif
</div>
</body>
</html>
