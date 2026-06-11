// public/js/app.js - Lógica del navegador: iconos, progreso en tiempo real,
// buscador, confirmaciones y botones de "Probar conexión".
(function () {
  'use strict';

  // Iconos (Lucide)
  if (window.lucide) lucide.createIcons();

  // -------------------------------------------------------------------------
  // Progreso y logs en tiempo real (Socket.IO)
  // -------------------------------------------------------------------------
  function renderJob(job) {
    var card = document.getElementById('job-card');
    if (!card) return;
    if (!job || !job.active) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    document.getElementById('job-name').textContent = job.name || 'Tarea';
    document.getElementById('job-msg').textContent = job.message || '';
    var count = document.getElementById('job-count');
    var bar = document.getElementById('job-bar');
    if (job.total > 0) {
      count.textContent = job.current + ' / ' + job.total;
      bar.style.width = Math.min(100, Math.round((job.current / job.total) * 100)) + '%';
    } else {
      count.textContent = '';
      bar.style.width = '12%';
    }
  }

  function addLogLine(l) {
    var box = document.getElementById('logbox');
    if (!box) return;
    var empty = box.querySelector('.empty');
    if (empty) empty.remove();
    var div = document.createElement('div');
    div.className = 'log-line log-' + l.level;
    var t = document.createElement('span'); t.className = 'log-time'; t.textContent = l.created_at;
    var lv = document.createElement('span'); lv.className = 'log-level'; lv.textContent = l.level;
    var m = document.createElement('span'); m.className = 'log-msg'; m.textContent = l.message;
    div.appendChild(t); div.appendChild(lv); div.appendChild(m);
    box.insertBefore(div, box.firstChild);
  }

  if (window.io) {
    try {
      var socket = io();
      socket.on('progress', renderJob);
      socket.on('log', addLogLine);
    } catch (e) { /* sin tiempo real, la página sigue funcionando */ }
  }

  // Al cargar la página, pregunta si hay una tarea en marcha
  if (document.getElementById('job-card')) {
    fetch('/api/job')
      .then(function (r) { return r.json(); })
      .then(renderJob)
      .catch(function () {});
  }

  // -------------------------------------------------------------------------
  // Buscador en tiempo real de la tabla de copias
  // -------------------------------------------------------------------------
  window.filterTable = function () {
    var q = (document.getElementById('search').value || '').toLowerCase().trim();
    document.querySelectorAll('#backups-table tbody tr').forEach(function (tr) {
      tr.style.display = !q || (tr.dataset.search || '').indexOf(q) !== -1 ? '' : 'none';
    });
  };

  // -------------------------------------------------------------------------
  // Confirmaciones en formularios peligrosos (data-confirm)
  // y pregunta extra para restauraciones (data-wipe-ask)
  // -------------------------------------------------------------------------
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    var msg = form.getAttribute('data-confirm');
    if (!msg) return;
    if (!window.confirm(msg)) {
      ev.preventDefault();
      return;
    }
    if (form.getAttribute('data-wipe-ask') === '1') {
      var wipe = window.confirm('¿Quieres VACIAR los archivos actuales del servidor antes de restaurar?\n\nAceptar = vaciar y restaurar limpio.\nCancelar = restaurar encima de los archivos actuales.');
      var input = form.querySelector('input[name="wipe"]');
      if (input) input.value = wipe ? '1' : '0';
    }
  });

  // -------------------------------------------------------------------------
  // Botones "Probar conexión" (nodos y panel)
  // -------------------------------------------------------------------------
  window.testConnection = function (url, btn) {
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Probando...';
    fetch(url, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        window.alert((data.ok ? 'CORRECTO: ' : 'ERROR: ') + data.message);
      })
      .catch(function (e) {
        window.alert('ERROR: ' + e.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.innerHTML = original;
        if (window.lucide) lucide.createIcons();
      });
  };

  // -------------------------------------------------------------------------
  // Modal de restauración de la BD del panel
  // -------------------------------------------------------------------------
  window.openPanelRestore = function (backupId) {
    var dlg = document.getElementById('panel-restore');
    if (!dlg) return;
    var sel = document.getElementById('panel-backup-select');
    if (sel && backupId) sel.value = String(backupId);
    dlg.showModal();
  };

  // Cerrar el modal al hacer clic fuera
  document.querySelectorAll('dialog.modal').forEach(function (dlg) {
    dlg.addEventListener('click', function (ev) {
      if (ev.target === dlg) dlg.close();
    });
  });
})();
