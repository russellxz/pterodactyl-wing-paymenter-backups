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

    <div class="pb-card pb-job" id="pb-job" hidden>
        <div class="pb-job-head">
            <span class="pb-spinner"></span>
            <b id="pb-job-name">Tarea</b>
            <span class="pb-muted" id="pb-job-msg"></span>
            <span class="pb-count" id="pb-job-count"></span>
        </div>
        <div class="pb-progress"><div class="pb-bar" id="pb-job-bar" style="width:0%"></div></div>
    </div>

    <div class="pb-card">
        <h2>Backup 2.0 · Copias disponibles de tu servidor</h2>
        <p class="pb-muted pb-small">Puedes descargar cualquier copia o restaurarla a tu servidor. Al restaurar, te preguntaremos si quieres vaciar los archivos actuales antes.</p>
        <div id="pb-list"><p class="pb-muted">Cargando copias...</p></div>
    </div>

    <script>
    (function () {
        'use strict';
        var BASE = '/pterobackups/server/{{ $short }}';
        var CSRF = '{{ csrf_token() }}';
        var wasActive = false;

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

        function loadList() {
            fetch(BASE + '/list', { headers: { 'Accept': 'application/json' } })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    var box = document.getElementById('pb-list');
                    if (!d.ok) { box.innerHTML = '<p class="pb-muted">' + esc(d.message || 'Error al cargar.') + '</p>'; return; }
                    if (!d.rows || !d.rows.length) {
                        box.innerHTML = '<p class="pb-muted">Tu servidor todavía no tiene copias remotas. Se crearán automáticamente según la programación del administrador.</p>';
                        return;
                    }
                    var html = '<table class="pb-table"><thead><tr><th>Fecha de la copia</th><th>Tamaño</th><th>Acciones</th></tr></thead><tbody>';
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

        window.pbRestore = function (id) {
            if (!confirm('¿Restaurar esta copia a tu servidor? Los archivos de la copia sobrescribirán los actuales.')) return;
            var wipe = confirm('¿Quieres VACIAR los archivos actuales antes de restaurar?\n\nAceptar = vaciar y restaurar limpio.\nCancelar = restaurar encima de los archivos actuales.');
            fetch(BASE + '/restore/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': CSRF, 'Accept': 'application/json' },
                body: JSON.stringify({ wipe: wipe })
            })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (!d.ok) alert('No se pudo iniciar: ' + (d.message || 'error'));
                    pollJob();
                })
                .catch(function (e) { alert('Error: ' + e.message); });
        };

        function renderJob(j) {
            var card = document.getElementById('pb-job');
            if (!j || !j.active) {
                card.hidden = true;
                if (wasActive) { wasActive = false; loadList(); }
                return;
            }
            wasActive = true;
            card.hidden = false;
            document.getElementById('pb-job-name').textContent = j.name || 'Tarea';
            document.getElementById('pb-job-msg').textContent = j.message || '';
            var bar = document.getElementById('pb-job-bar');
            var count = document.getElementById('pb-job-count');
            if (j.total > 0) {
                count.textContent = j.current + ' / ' + j.total;
                bar.style.width = Math.min(100, Math.round((j.current / j.total) * 100)) + '%';
            } else {
                count.textContent = '';
                bar.style.width = '15%';
            }
        }

        function pollJob() {
            fetch(BASE + '/job', { headers: { 'Accept': 'application/json' } })
                .then(function (r) { return r.json(); })
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
