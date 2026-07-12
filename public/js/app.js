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
    el('job-name').textContent = job.name || 'Task';
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
      if (job.cancelRequested) cancelBtn.textContent = 'Canceling...';
    }
  }

  window.cancelJob = function () {
    if (!window.confirm('Cancel the running task? It will stop after the current server finishes.')) return;
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
  var nextRunPaymenter = null;
  var nextRunCleanup = null;
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
    var box = el('auto-chips');
    if (!box) return;
    var now = Date.now() + serverOffset;
    var items = [
      { at: nextRunNodes, chip: el('auto-nodes'), num: el('auto-countdown-nodes') },
      { at: nextRunPanel, chip: el('auto-panel'), num: el('auto-countdown-panel') },
      { at: nextRunPaymenter, chip: el('auto-paymenter'), num: el('auto-countdown-paymenter') },
      { at: nextRunCleanup, chip: el('auto-cleanup'), num: el('auto-countdown-cleanup') }
    ];
    var any = false;
    items.forEach(function (it) {
      if (!it.chip) return;
      var show = !!it.at;
      it.chip.hidden = !show;
      if (show) {
        any = true;
        if (it.num) it.num.textContent = fmtDur(it.at - now);
      }
    });
    box.hidden = !any;
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
    nextRunPaymenter = data.next_run_paymenter || null;
    nextRunCleanup = data.next_run_cleanup || null;
    if (data.server_now) serverOffset = data.server_now - Date.now();
    updateCountdown();
  }

  // -------------------------------------------------------------------------
  // Menú lateral en móvil (botón hamburguesa de la barra superior)
  // -------------------------------------------------------------------------
  window.toggleMenu = function (force) {
    var open = typeof force === 'boolean' ? force : !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
  };
  // Al tocar un enlace del menú, se cierra (la página navega igualmente)
  document.querySelectorAll('.sidebar .nav a').forEach(function (a) {
    a.addEventListener('click', function () { window.toggleMenu(false); });
  });

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
      var hidden = q && (tr.dataset.search || '').indexOf(q) === -1;
      tr.style.display = hidden ? 'none' : '';
      // Al ocultar una fila por el buscador, la desmarco para no borrar algo
      // que ya no ves en pantalla.
      if (hidden) {
        var cb = tr.querySelector('.bulk-item');
        if (cb) cb.checked = false;
      }
    });
    updateBulk();
  };

  // -------------------------------------------------------------------------
  // Selección múltiple de copias (checkboxes + "Delete selected")
  // -------------------------------------------------------------------------
  // Botón "Select all / Deselect all": marca (o desmarca) todas las filas
  // visibles. Si ya está todo marcado, el botón desmarca.
  window.toggleSelectAll = function (btn) {
    var form = btn.closest('.bulk-form');
    if (!form) return;
    var items = Array.prototype.slice.call(form.querySelectorAll('.bulk-item')).filter(function (cb) {
      var tr = cb.closest('tr');
      return !tr || tr.style.display !== 'none';
    });
    var allChecked = items.length > 0 && items.every(function (cb) { return cb.checked; });
    items.forEach(function (cb) { cb.checked = !allChecked; });
    updateBulk();
  };

  function updateBulk() {
    document.querySelectorAll('.bulk-form').forEach(function (form) {
      var items = Array.prototype.slice.call(form.querySelectorAll('.bulk-item'));
      // Solo cuentan las filas visibles (el buscador puede ocultar algunas).
      var visible = items.filter(function (cb) {
        var tr = cb.closest('tr');
        return !tr || tr.style.display !== 'none';
      });
      var checked = visible.filter(function (cb) { return cb.checked; });
      var bar = form.querySelector('.bulk-bar');
      if (bar) {
        bar.hidden = checked.length === 0;
        var count = bar.querySelector('.bulk-count b');
        if (count) count.textContent = checked.length;
      }
      var all = form.querySelector('.bulk-all');
      if (all) {
        all.checked = visible.length > 0 && checked.length === visible.length;
        all.indeterminate = checked.length > 0 && checked.length < visible.length;
      }
      // Texto del botón grande: "Select all" o "Deselect all".
      var label = form.querySelector('.sa-label');
      if (label) {
        label.textContent = (visible.length > 0 && checked.length === visible.length) ? 'Deselect all' : 'Select all';
      }
    });
  }

  // Delegación: un click en cualquier checkbox de selección actualiza la barra.
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.classList && t.classList.contains('bulk-all')) {
      var form = t.closest('.bulk-form');
      if (form) {
        form.querySelectorAll('.bulk-item').forEach(function (cb) {
          var tr = cb.closest('tr');
          if (!tr || tr.style.display !== 'none') cb.checked = t.checked;
        });
      }
      updateBulk();
    } else if (t.classList && t.classList.contains('bulk-item')) {
      updateBulk();
    }
  });

  // Borrado individual: como el botón vive dentro del form de selección
  // múltiple, no puedo anidar otro form. Creo uno al vuelo y lo envío.
  window.deleteOne = function (btn, action, msg) {
    if (!window.confirm(msg)) return;
    var f = document.createElement('form');
    f.method = 'post';
    f.action = action;
    document.body.appendChild(f);
    f.submit();
  };

  // Restauración individual: igual que el borrado, el botón está dentro del
  // form de selección múltiple, así que creo el form al vuelo. Pide
  // confirmación y después la opción de vaciar los archivos actuales.
  window.restoreOne = function (action, msg) {
    if (!window.confirm(msg)) return;
    var wipe = window.confirm('Do you want to WIPE the server\'s current files before restoring?\n\nOK = wipe and restore clean.\nCancel = restore on top of the current files.');
    var f = document.createElement('form');
    f.method = 'post';
    f.action = action;
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'wipe';
    input.value = wipe ? '1' : '0';
    f.appendChild(input);
    document.body.appendChild(f);
    f.submit();
  };

  // Evita enviar "Delete selected" sin nada marcado.
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (form.classList && form.classList.contains('bulk-form')) {
      var any = form.querySelector('.bulk-item:checked');
      if (!any) {
        ev.preventDefault();
        window.alert('Select at least one backup first.');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Confirmaciones (data-confirm) y pregunta extra de vaciado (data-wipe-ask)
  // -------------------------------------------------------------------------
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    // Si es borrado múltiple sin nada marcado, ni siquiera preguntamos.
    if (form.classList && form.classList.contains('bulk-form') && !form.querySelector('.bulk-item:checked')) {
      return; // el otro manejador ya lo cancela y avisa
    }
    var msg = form.getAttribute('data-confirm');
    if (!msg) return;
    if (!window.confirm(msg)) {
      ev.preventDefault();
      return;
    }
    if (form.getAttribute('data-wipe-ask') === '1') {
      var wipe = window.confirm('Do you want to WIPE the server\'s current files before restoring?\n\nOK = wipe and restore clean.\nCancel = restore on top of the current files.');
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
        window.alert((data.ok ? 'SUCCESS: ' : 'ERROR: ') + data.message);
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

  window.openPaymenterRestore = function (backupId) {
    var dlg = el('paymenter-restore');
    if (!dlg) return;
    var sel = el('paymenter-backup-select');
    if (sel && backupId) sel.value = String(backupId);
    dlg.showModal();
  };

  document.querySelectorAll('dialog.modal').forEach(function (dlg) {
    dlg.addEventListener('click', function (ev) {
      if (ev.target === dlg) dlg.close();
    });
  });
})();
