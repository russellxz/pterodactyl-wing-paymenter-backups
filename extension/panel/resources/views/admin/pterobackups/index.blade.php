@extends('layouts.admin')

@section('title')
    PteroBackups
@endsection

@section('content-header')
    <h1>PteroBackups<small>Copias de seguridad remotas de servidores y paneles.</small></h1>
    <ol class="breadcrumb">
        <li><a href="{{ route('admin.index') }}">Admin</a></li>
        <li class="active">PteroBackups</li>
    </ol>
@endsection

@section('content')
@if (session('pb_ok'))
    <div class="alert alert-success">{{ session('pb_ok') }}</div>
@endif
@if (session('pb_err'))
    <div class="alert alert-danger">{{ session('pb_err') }}</div>
@endif

<div class="row">
    <div class="col-xs-12">
        <div class="box box-primary">
            <div class="box-header with-border">
                <h3 class="box-title">Conexión con el sistema de copias</h3>
            </div>
            <form method="POST" action="{{ route('admin.pterobackups.settings') }}">
                <div class="box-body">
                    {!! csrf_field() !!}
                    <div class="row">
                        <div class="form-group col-md-6">
                            <label>URL del sistema</label>
                            <input type="text" name="url" class="form-control" value="{{ $settings['url'] }}" placeholder="https://copias.tudominio.com" required>
                        </div>
                        <div class="form-group col-md-6">
                            <label>Clave de API</label>
                            <input type="text" name="api_key" class="form-control" value="{{ $settings['key'] }}" placeholder="Pega aquí la clave" required>
                        </div>
                    </div>
                    <p class="text-muted small">Los dos datos están en tu sistema de copias: <b>Configuración &rarr; Extensión del panel</b>. La conexión se guarda en la base de datos del panel: si reinstalas el panel con la misma BD y vuelves a instalar la extensión, reconecta sola.</p>
                </div>
                <div class="box-footer">
                    <button type="submit" class="btn btn-primary btn-sm">Guardar y probar conexión</button>
                </div>
            </form>
        </div>
    </div>
</div>

@if ($configured)
<div class="row">
    <div class="col-xs-12">

        <div class="box box-warning" id="pb-job-box" style="display:none">
            <div class="box-header with-border">
                <h3 class="box-title"><span id="pb-job-name">Tarea</span> &mdash; <span id="pb-job-msg" class="text-muted"></span></h3>
                <div class="box-tools">
                    <span id="pb-job-count" style="margin-right:10px;font-weight:bold"></span>
                    <button type="button" class="btn btn-danger btn-xs" onclick="pbCancel()">Cancelar</button>
                </div>
            </div>
            <div class="box-body">
                <div class="progress" style="margin-bottom:0">
                    <div class="progress-bar progress-bar-yellow" id="pb-job-bar" style="width:0%"></div>
                </div>
            </div>
        </div>

        <div class="box box-success">
            <div class="box-header with-border">
                <h3 class="box-title">Hacer copia ahora</h3>
                <div class="box-tools"><span class="text-muted" id="pb-countdown"></span></div>
            </div>
            <div class="box-body form-inline">
                <select id="pb-run-target" class="form-control" onchange="document.getElementById('pb-run-node').style.display = this.value === 'node' ? '' : 'none'">
                    <option value="both">Todo (nodos + BD de paneles)</option>
                    <option value="nodes">Solo nodos</option>
                    <option value="panel">Solo BD de los paneles</option>
                    <option value="node">Un nodo específico</option>
                </select>
                <select id="pb-run-node" class="form-control" style="display:none"></select>
                <button type="button" class="btn btn-success" onclick="pbRun()">Iniciar copia</button>
            </div>
        </div>

        <div id="pb-app">
            <div class="box"><div class="box-body text-muted">Cargando...</div></div>
        </div>

        <div class="box">
            <div class="box-header with-border"><h3 class="box-title">Programación automática del sistema</h3></div>
            <div class="box-body form-inline">
                <label>Copias automáticas&nbsp;</label>
                <select id="pb-sch" class="form-control">
                    <option value="0">Desactivadas</option>
                    <option value="1">Cada 1 hora</option>
                    <option value="24">Cada 1 día</option>
                    <option value="168">Cada 7 días</option>
                    <option value="360">Cada 15 días</option>
                    <option value="720">Cada 30 días</option>
                </select>
                &nbsp;&nbsp;<label>Qué se copia&nbsp;</label>
                <select id="pb-target" class="form-control">
                    <option value="both">Todo</option>
                    <option value="nodes">Solo nodos</option>
                    <option value="panel">Solo BD de paneles</option>
                </select>
                &nbsp;&nbsp;<label>Borrar copias antiguas&nbsp;</label>
                <select id="pb-ret" class="form-control">
                    <option value="0">Nunca</option>
                    <option value="1">Con más de 1 hora</option>
                    <option value="24">Con más de 1 día</option>
                    <option value="168">Con más de 7 días</option>
                    <option value="360">Con más de 15 días</option>
                    <option value="720">Con más de 30 días</option>
                </select>
                &nbsp;&nbsp;<button type="button" class="btn btn-primary" onclick="pbSaveSchedule()">Guardar programación</button>
            </div>
        </div>

    </div>
</div>

<script>
(function () {
    'use strict';
    window.PB_BASE = '/admin/pterobackups';
    window.PB_CSRF = '{{ csrf_token() }}';
})();

var pbView = { type: 'overview' };
var pbNextRun = null;
var pbOffset = 0;
var pbWasActive = false;

function pbEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function pbSize(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
}

function pbApi(path, method, body, _retried) {
    var opts = {
        method: method || 'GET',
        headers: { 'Accept': 'application/json', 'X-CSRF-TOKEN': window.PB_CSRF, 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin'
    };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    return fetch(window.PB_BASE + path, opts).then(function (r) {
        return r.text().then(function (t) {
            try {
                return JSON.parse(t);
            } catch (e) {
                // 403/429 suelen venir de Cloudflare (Bot Fight Mode). Reintentar una vez.
                if ((r.status === 403 || r.status === 429) && !_retried) {
                    return new Promise(function (res) {
                        setTimeout(function () { res(pbApi(path, method, body, true)); }, 1200);
                    });
                }
                if (r.status === 403 || r.status === 429) {
                    return { ok: false, message: 'Cloudflare bloqueó la petición (código ' + r.status + '). En Cloudflare desactiva "Bot Fight Mode" o crea una regla WAF que omita la ruta /pterobackups.' };
                }
                if (r.status === 419) {
                    return { ok: false, message: 'Tu sesión expiró. Recarga la página (F5) e inténtalo de nuevo.' };
                }
                return { ok: false, message: 'Respuesta inesperada del servidor (código ' + r.status + '). Recarga la página e inténtalo de nuevo.' };
            }
        });
    });
}

function pbWipeAsk() {
    return confirm('¿Quieres VACIAR los archivos actuales antes de restaurar?\n\nAceptar = vaciar y restaurar limpio.\nCancelar = restaurar encima de los archivos actuales.');
}

// --------------------------- Progreso ---------------------------
function pbRenderJob(j) {
    var box = document.getElementById('pb-job-box');
    if (!j || !j.active) {
        box.style.display = 'none';
        if (pbWasActive) { pbWasActive = false; pbRefresh(); }
    } else {
        pbWasActive = true;
        box.style.display = '';
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
    if (j) {
        pbNextRun = j.next_run || null;
        if (j.server_now) pbOffset = j.server_now - Date.now();
    }
}

function pbPollJob() {
    pbApi('/api/job').then(pbRenderJob).catch(function () {});
}

function pbCountdown() {
    var el = document.getElementById('pb-countdown');
    if (!el) return;
    if (!pbNextRun) { el.textContent = ''; return; }
    var s = Math.max(0, Math.floor((pbNextRun - (Date.now() + pbOffset)) / 1000));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    function pad(n) { return String(n).padStart(2, '0'); }
    el.textContent = 'Próxima copia automática en ' + (d ? d + 'd ' : '') + pad(h) + 'h ' + pad(m) + 'm ' + pad(s) + 's';
}

function pbCancel() {
    if (!confirm('¿Cancelar la tarea en curso?')) return;
    pbApi('/api/cancel', 'POST').then(function (d) { if (!d.ok) alert(d.message); });
}

function pbRun() {
    var target = document.getElementById('pb-run-target').value;
    var nodeId = document.getElementById('pb-run-node').value;
    pbApi('/api/run', 'POST', { target: target, node_id: nodeId }).then(function (d) {
        if (!d.ok) alert(d.message || 'No se pudo iniciar.');
        pbPollJob();
    });
}

// --------------------------- Vistas ---------------------------
function pbRefresh() {
    if (pbView.type === 'node') return pbOpenNode(pbView.id);
    if (pbView.type === 'snapshot') return pbOpenSnapshot(pbView.id, pbView.nodeId);
    return pbLoadOverview();
}

function pbLoadOverview() {
    pbView = { type: 'overview' };
    pbApi('/api/overview').then(function (d) {
        var app = document.getElementById('pb-app');
        if (!d.ok) { app.innerHTML = '<div class="box"><div class="box-body text-danger">' + pbEsc(d.message) + '</div></div>'; return; }

        // Selector de nodo para la copia manual
        var nodeSel = document.getElementById('pb-run-node');
        nodeSel.innerHTML = d.nodes.map(function (n) {
            return '<option value="' + n.id + '">' + pbEsc(n.name) + '</option>';
        }).join('');

        var html = '<div class="box"><div class="box-header with-border"><h3 class="box-title">Copias por nodo</h3></div><div class="box-body table-responsive no-padding">';
        if (!d.nodes.length) {
            html += '<div class="box-body text-muted">No hay nodos configurados en el sistema.</div>';
        } else {
            html += '<table class="table table-hover"><thead><tr><th>Nodo</th><th>IP</th><th>Fechas de copia</th><th>Última</th><th>Espacio</th><th></th></tr></thead><tbody>';
            d.nodes.forEach(function (n) {
                html += '<tr><td><strong>' + pbEsc(n.name) + '</strong></td><td>' + pbEsc(n.host) + '</td><td>' + n.snaps + '</td><td>' + pbEsc(n.last_snap || 'Nunca') + '</td><td>' + pbSize(n.total_size) + '</td>' +
                    '<td class="text-right"><button class="btn btn-xs btn-primary" onclick="pbOpenNode(' + n.id + ')">Ver fechas</button></td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div></div>';

        html += '<div class="box"><div class="box-header with-border"><h3 class="box-title">Copias de la BD de los paneles</h3></div><div class="box-body table-responsive no-padding">';
        if (!d.panel_backups.length) {
            html += '<div class="box-body text-muted">Todavía no hay copias de bases de datos.</div>';
        } else {
            html += '<table class="table table-hover"><thead><tr><th>Panel</th><th>Tamaño</th><th>Fecha</th><th></th></tr></thead><tbody>';
            d.panel_backups.forEach(function (b) {
                html += '<tr><td><strong>' + pbEsc(b.panel_name || 'Panel eliminado') + '</strong></td><td>' + pbSize(b.size) + '</td><td>' + pbEsc(b.created_at) + '</td>' +
                    '<td class="text-right">' +
                    '<a class="btn btn-xs btn-default" href="' + window.PB_BASE + '/download/' + b.id + '">Descargar</a> ' +
                    '<button class="btn btn-xs btn-danger" onclick="pbDeleteBk(' + b.id + ')">Eliminar</button>' +
                    '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '<div class="box-body text-muted small">La BD del panel se restaura desde la página del sistema de copias (permite elegir el panel guardado u otro VPS).</div>';
        html += '</div></div>';

        app.innerHTML = html;
    });
}

function pbOpenNode(id) {
    pbView = { type: 'node', id: id };
    pbApi('/api/nodes/' + id + '/snapshots').then(function (d) {
        var app = document.getElementById('pb-app');
        if (!d.ok) { app.innerHTML = '<div class="box"><div class="box-body text-danger">' + pbEsc(d.message) + '</div></div>'; return; }
        var ST = { running: ['En curso', 'label-info'], complete: ['Completa', 'label-success'], canceled: ['Cancelada', 'label-warning'], error: ['Error', 'label-danger'] };
        var html = '<div class="box"><div class="box-header with-border">' +
            '<h3 class="box-title">Fechas de copia del nodo: ' + pbEsc(d.node.name) + '</h3>' +
            '<div class="box-tools"><button class="btn btn-xs btn-default" onclick="pbLoadOverview()">&larr; Volver</button></div>' +
            '</div><div class="box-body table-responsive no-padding">';
        if (!d.snapshots.length) {
            html += '<div class="box-body text-muted">Este nodo todavía no tiene fechas de copia.</div>';
        } else {
            html += '<table class="table table-hover"><thead><tr><th>Fecha</th><th>Estado</th><th>Servidores</th><th>Tamaño</th><th></th></tr></thead><tbody>';
            d.snapshots.forEach(function (s) {
                var st = ST[s.status] || [s.status, 'label-default'];
                html += '<tr><td><strong>' + pbEsc(s.created_at) + '</strong></td>' +
                    '<td><span class="label ' + st[1] + '">' + st[0] + '</span></td>' +
                    '<td>' + s.cnt + '</td><td>' + pbSize(s.total_size) + '</td>' +
                    '<td class="text-right">' +
                    '<button class="btn btn-xs btn-primary" onclick="pbOpenSnapshot(' + s.id + ',' + d.node.id + ')">Ver copia</button> ' +
                    '<button class="btn btn-xs btn-warning" onclick="pbRestoreSnap(' + s.id + ')">Restaurar todo</button> ' +
                    '<button class="btn btn-xs btn-danger" onclick="pbDeleteSnap(' + s.id + ')">Eliminar</button>' +
                    '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div></div>';
        app.innerHTML = html;
    });
}

function pbOpenSnapshot(id, nodeId) {
    pbView = { type: 'snapshot', id: id, nodeId: nodeId };
    pbApi('/api/snapshots/' + id).then(function (d) {
        var app = document.getElementById('pb-app');
        if (!d.ok) { app.innerHTML = '<div class="box"><div class="box-body text-danger">' + pbEsc(d.message) + '</div></div>'; return; }
        var html = '<div class="box"><div class="box-header with-border">' +
            '<h3 class="box-title">Copia del ' + pbEsc(d.snapshot.created_at) + ' &mdash; ' + d.rows.length + ' servidores</h3>' +
            '<div class="box-tools">' +
            '<button class="btn btn-xs btn-default" onclick="pbOpenNode(' + (d.node ? d.node.id : nodeId) + ')">&larr; Volver</button> ' +
            '<button class="btn btn-xs btn-warning" onclick="pbRestoreSnap(' + d.snapshot.id + ')">Restaurar toda esta fecha</button>' +
            '</div></div>' +
            '<div class="box-body"><input type="text" class="form-control" placeholder="Buscar por nombre, correo o servidor..." oninput="pbFilter(this.value)"></div>' +
            '<div class="box-body table-responsive no-padding">';
        if (!d.rows.length) {
            html += '<div class="box-body text-muted">Esta fecha no tiene servidores guardados.</div>';
        } else {
            html += '<table class="table table-hover" id="pb-snap-table"><thead><tr><th>Usuario</th><th>Correo</th><th>Servidor</th><th>Tamaño</th><th></th></tr></thead><tbody>';
            d.rows.forEach(function (b) {
                var searchKey = (String(b.owner_name) + ' ' + String(b.owner_email) + ' ' + String(b.server_name)).toLowerCase();
                html += '<tr data-search="' + pbEsc(searchKey) + '">' +
                    '<td>' + pbEsc(b.owner_name) + '</td><td class="text-muted">' + pbEsc(b.owner_email) + '</td>' +
                    '<td><strong>' + pbEsc(b.server_name) + '</strong></td><td>' + pbSize(b.size) + '</td>' +
                    '<td class="text-right">' +
                    '<a class="btn btn-xs btn-default" href="' + window.PB_BASE + '/download/' + b.id + '">Descargar</a> ' +
                    '<button class="btn btn-xs btn-warning" onclick="pbRestoreBk(' + b.id + ')">Restaurar</button> ' +
                    '<button class="btn btn-xs btn-danger" onclick="pbDeleteBk(' + b.id + ')">Eliminar</button>' +
                    '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div></div>';
        app.innerHTML = html;
    });
}

function pbFilter(q) {
    q = (q || '').toLowerCase().trim();
    var rows = document.querySelectorAll('#pb-snap-table tbody tr');
    rows.forEach(function (tr) {
        tr.style.display = !q || (tr.getAttribute('data-search') || '').indexOf(q) !== -1 ? '' : 'none';
    });
}

// --------------------------- Acciones ---------------------------
function pbRestoreSnap(id) {
    if (!confirm('¿Restaurar TODOS los servidores de esta fecha a su nodo? (La BD del panel NO se toca).')) return;
    var wipe = pbWipeAsk();
    pbApi('/api/snapshots/' + id + '/restore', 'POST', { wipe: wipe }).then(function (d) {
        if (!d.ok) alert(d.message);
        pbPollJob();
    });
}

function pbDeleteSnap(id) {
    if (!confirm('¿Eliminar esta fecha de copia completa? No se puede deshacer.')) return;
    pbApi('/api/snapshots/' + id + '/delete', 'POST').then(function (d) {
        if (!d.ok) alert(d.message);
        pbRefresh();
    });
}

function pbRestoreBk(id) {
    if (!confirm('¿Restaurar esta copia del servidor a su nodo? Los archivos de la copia sobrescribirán los actuales.')) return;
    var wipe = pbWipeAsk();
    pbApi('/api/backups/' + id + '/restore', 'POST', { wipe: wipe }).then(function (d) {
        if (!d.ok) alert(d.message);
        pbPollJob();
    });
}

function pbDeleteBk(id) {
    if (!confirm('¿Eliminar esta copia? No se puede deshacer.')) return;
    pbApi('/api/backups/' + id + '/delete', 'POST').then(function (d) {
        if (!d.ok) alert(d.message);
        pbRefresh();
    });
}

// --------------------------- Programación ---------------------------
function pbLoadSchedule() {
    pbApi('/api/schedule').then(function (d) {
        if (!d.ok) return;
        document.getElementById('pb-sch').value = String(d.schedule_hours || '0');
        document.getElementById('pb-target').value = String(d.backup_target || 'both');
        document.getElementById('pb-ret').value = String(d.retention_hours || '0');
    });
}

function pbSaveSchedule() {
    pbApi('/api/schedule', 'POST', {
        schedule_hours: document.getElementById('pb-sch').value,
        retention_hours: document.getElementById('pb-ret').value,
        backup_target: document.getElementById('pb-target').value
    }).then(function (d) {
        alert(d.ok ? 'Programación guardada.' : ('Error: ' + d.message));
        pbPollJob();
    });
}

// --------------------------- Arranque ---------------------------
pbLoadOverview();
pbLoadSchedule();
pbPollJob();
setInterval(pbPollJob, 3000);
setInterval(pbCountdown, 1000);
</script>
@endif
@endsection
