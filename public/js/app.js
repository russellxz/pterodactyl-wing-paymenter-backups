// public/js/app.js - Lógica del navegador: iconos, progreso en tiempo real
// (persistente aunque recargues), cancelación, contador de la próxima copia
// automática, buscador, confirmaciones y pruebas de conexión.
(function () {
  'use strict';

  if (window.lucide) lucide.createIcons();

  function el(id) { return document.getElementById(id); }

  // -------------------------------------------------------------------------
  // Progreso de la tarea actual
  // -------------------------------------------------------------------------
  function renderJob(job) {
    var card = el('job-card');
    if (!card) return;
    if (!job || !job.active) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    el('job-name').textContent = job.name || 'Tarea';
    el('job-msg').textContent = job.message || '';
    var count = el('job-count');
    var bar = el('job-bar');
    if (job.total > 0) {
      count.textContent = job.current + ' / ' + job.total;
      bar.style.width = Math.min(100, Math.round((job.current / job.total) * 100)) + '%';
    } else {
      count.textContent = '';
      bar.style.width = '12%';
    }
    var cancelBtn = el('job-cancel');
    if (cancelBtn) {
      cancelBtn.disabled = !!job.cancelRequested;
      if (job.cancelRequested) cancelBtn.textContent = 'Cancelando...';
    }
  }

  window.cancelJob = function () {
    if (!window.confirm('¿Cancelar la tarea en curso? Se detendrá al terminar el servidor actual.')) return;
    fetch('/api/job/cancel', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.ok) window.alert(d.message); })
      .catch(function () {});
  };

  // -------------------------------------------------------------------------
  // Contador en tiempo real de la próxima copia automática
  // -------------------------------------------------------------------------
  var nextRunNodes = null;
  var nextRunPanel = null;
  var serverOffset = 0; // diferencia entre el reloj del servidor y el del navegador

  function fmtDur(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return (d ? d + 'd ' : '') + pad(h) + 'h ' + pad(m) + 'm ' + pad(s) + 's';
  }

  function updateCountdown() {
    var chip = el('auto-chip');
    if (!chip) return;
    var now = Date.now() + serverOffset;
    var showNodes = !!nextRunNodes;
    var showPanel = !!nextRunPanel;
    if (!showNodes && !showPanel) { chip.hidden = true; return; }
    chip.hidden = false;
    var nodesSpan = el('auto-nodes');
    var panelSpan = el('auto-panel');
    var sep = el('auto-sep');
    if (nodesSpan) {
      nodesSpan.hidden = !showNodes;
      if (showNodes) el('auto-countdown-nodes').textContent = fmtDur(nextRunNodes - now);
    }
    if (panelSpan) {
      panelSpan.hidden = !showPanel;
      if (showPanel) el('auto-countdown-panel').textContent = fmtDur(nextRunPanel - now);
    }
    if (sep) sep.hidden = !(showNodes && showPanel);
  }
  setInterval(updateCountdown, 1000);

  // -------------------------------------------------------------------------
  // Estado desde el servidor: al cargar, por socket y por sondeo cada 5 s
  // (así el progreso NO desaparece aunque recargues la página)
  // -------------------------------------------------------------------------
  function applyState(data) {
    if (!data) return;
    renderJob(data);
    nextRunNodes = data.next_run_nodes || null;
    nextRunPanel = data.next_run_panel || null;
    if (data.server_now) serverOffset = data.server_now - Date.now();
    updateCountdown();
  }

  function fetchState() {
    fetch('/api/job')
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function () {});
  }

  if (el('job-card')) {
    fetchState();
    setInterval(fetchState, 5000);
  }

  if (window.io) {
    try {
      var socket = io();
      socket.on('progress', renderJob);
      socket.on('log', addLogLine);
    } catch (e) { /* sin tiempo real, la página sigue funcionando */ }
  }

  // -------------------------------------------------------------------------
  // Logs en vivo
  // -------------------------------------------------------------------------
  function addLogLine(l) {
    var box = el('logbox');
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

  // -------------------------------------------------------------------------
  // Buscador en tiempo real de tablas de copias
  // -------------------------------------------------------------------------
  window.filterTable = function () {
    var q = (el('search').value || '').toLowerCase().trim();
    document.querySelectorAll('#backups-table tbody tr').forEach(function (tr) {
      tr.style.display = !q || (tr.dataset.search || '').indexOf(q) !== -1 ? '' : 'none';
    });
  };

  // -------------------------------------------------------------------------
  // Confirmaciones (data-confirm) y pregunta extra de vaciado (data-wipe-ask)
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
  // Botones "Probar conexión" (nodos y paneles)
  // -------------------------------------------------------------------------
  window.testConnection = function (url, btn) {
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
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
  // Modales
  // -------------------------------------------------------------------------
  window.openDialog = function (id) {
    var dlg = el(id);
    if (dlg) dlg.showModal();
  };

  window.openPanelRestore = function (backupId) {
    var dlg = el('panel-restore');
    if (!dlg) return;
    var sel = el('panel-backup-select');
    if (sel && backupId) sel.value = String(backupId);
    dlg.showModal();
  };

  document.querySelectorAll('dialog.modal').forEach(function (dlg) {
    dlg.addEventListener('click', function (ev) {
      if (ev.target === dlg) dlg.close();
    });
  });
})();
