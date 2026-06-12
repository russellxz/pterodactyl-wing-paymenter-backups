// PteroBackups - inject.js (v2.8)
// Añade la opción "Backup 2.0" al menú lateral de cada servidor SIN
// recompilar el panel. Funciona clonando la fila "Files" del menú del tema
// activo (panel normal, Arix v2, etc.), buscándola incluso dentro de
// Shadow DOM. Si el tema no se deja, muestra un botón flotante propio.
(function () {
  'use strict';

  console.info('[PteroBackups] inject.js v2.8 cargado.');

  var LABEL = 'Backup 2.0';
  var FLOAT_DELAY = 2500;
  var startedAt = Date.now();
  var tries = 0;

  function currentShort() {
    var m = window.location.pathname.match(/\/server\/([a-zA-Z0-9-]{4,40})(\/|$)/);
    if (m) return m[1];
    if (window.location.pathname.indexOf('/server') !== -1) {
      var links = document.querySelectorAll('a[href*="/server/"]');
      for (var i = 0; i < links.length; i++) {
        var mm = (links[i].getAttribute('href') || '').match(/\/server\/([a-zA-Z0-9-]{4,40})(\/|$)/);
        if (mm) return mm[1];
      }
    }
    return null;
  }

  function targetUrl(short) {
    return '/pterobackups/server/' + short;
  }

  // Busca elementos también dentro de Shadow DOM (algunos temas lo usan)
  function queryAllDeep(selector, root, out) {
    root = root || document;
    out = out || [];
    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) out.push(found[i]);
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) queryAllDeep(selector, all[j].shadowRoot, out);
    }
    return out;
  }

  // Sube desde el texto encontrado hasta la FILA completa del menú
  // (el elemento más grande que solo contiene ese texto: icono + etiqueta)
  function rowFor(el, text) {
    var row = el;
    while (row.parentElement) {
      var pt = (row.parentElement.textContent || '').trim().toLowerCase();
      if (pt !== text) break;
      row = row.parentElement;
    }
    return row;
  }

  // Devuelve todas las filas "Files" de los menús visibles (puede haber dos:
  // el menú lateral y el desplegable del celular)
  function findMenuRows(short) {
    var rows = [];
    var seen = [];

    function push(el, text) {
      if (!el || el.closest('.pb-nav-clone') || el.id === 'pb-float') return;
      var row = rowFor(el, text);
      if (seen.indexOf(row) === -1) { seen.push(row); rows.push(row); }
    }

    var anchors = queryAllDeep('a[href*="/server/' + short + '/files"]');
    for (var i = 0; i < anchors.length; i++) {
      push(anchors[i], (anchors[i].textContent || '').trim().toLowerCase());
    }

    if (!rows.length) {
      var texts = ['files', 'archivos', 'file manager', 'gestor de archivos'];
      var nodes = queryAllDeep('a, button, li, span, p, div, [role="link"], [role="button"]');
      for (var j = 0; j < nodes.length; j++) {
        var t = (nodes[j].textContent || '').trim().toLowerCase();
        if (t && texts.indexOf(t) !== -1) push(nodes[j], t);
      }
    }
    return rows;
  }

  function setLabel(root) {
    var els = root.querySelectorAll('span, p, div, strong, b, a');
    for (var i = 0; i < els.length; i++) {
      if (els[i].children.length === 0 && els[i].textContent.trim()) {
        els[i].textContent = LABEL;
        return;
      }
    }
    var kids = root.childNodes;
    for (var j = 0; j < kids.length; j++) {
      if (kids[j].nodeType === 3 && kids[j].textContent.trim()) {
        kids[j].textContent = ' ' + LABEL;
        return;
      }
    }
    root.textContent = LABEL;
  }

  function cleanActive(el) {
    if (el.className && typeof el.className === 'string') {
      el.className = el.className.replace(/\bactive\b/g, '').trim();
    }
    if (el.removeAttribute) el.removeAttribute('aria-current');
  }

  function removeClones(rootless) {
    var clones = document.querySelectorAll('.pb-nav-clone');
    for (var i = 0; i < clones.length; i++) clones[i].remove();
    var f = document.getElementById('pb-float');
    if (f && rootless) f.remove();
  }

  function ensureFloating(short) {
    var f = document.getElementById('pb-float');
    if (document.querySelector('.pb-nav-clone')) {
      if (f) f.remove();
      return;
    }
    if (Date.now() - startedAt < FLOAT_DELAY) return;
    if (f) {
      f.setAttribute('href', targetUrl(short));
      return;
    }
    f = document.createElement('a');
    f.id = 'pb-float';
    f.setAttribute('href', targetUrl(short));
    f.textContent = LABEL;
    f.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;' +
      'background:#151c2c;color:#ffb84d;border:1px solid #f0a33c;border-radius:10px;' +
      'padding:10px 16px;font:600 13px system-ui,-apple-system,sans-serif;' +
      'text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,0.45);';
    document.body.appendChild(f);
    console.info('[PteroBackups] Menú del tema no detectado: botón flotante añadido.');
  }

  function makeClone(row, short) {
    var clone = row.cloneNode(true);
    clone.classList.add('pb-nav-clone');
    cleanActive(clone);
    var a = clone.tagName === 'A' ? clone : clone.querySelector('a');
    if (a) {
      a.setAttribute('href', targetUrl(short));
      cleanActive(a);
    }
    setLabel(clone);
    clone.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      window.location.href = targetUrl(currentShort() || short);
    }, true);
    return clone;
  }

  var lastRun = 0;

  function inject() {
    var now = Date.now();
    if (now - lastRun < 500) return; // no más de 2 pasadas por segundo
    lastRun = now;

    var short = currentShort();

    if (!short) {
      removeClones(true);
      return;
    }

    // Si el botón ya está en el menú, solo actualizar el enlace (barato)
    var existing = document.querySelectorAll('.pb-nav-clone');
    if (existing.length) {
      for (var e = 0; e < existing.length; e++) {
        var lnk = existing[e].tagName === 'A' ? existing[e] : existing[e].querySelector('a');
        if (lnk) lnk.setAttribute('href', targetUrl(short));
      }
      var fl = document.getElementById('pb-float');
      if (fl) fl.remove();
      return;
    }

    var rows = findMenuRows(short);
    var added = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var next = row.nextElementSibling;
      if (next && next.classList && next.classList.contains('pb-nav-clone')) {
        var link = next.tagName === 'A' ? next : next.querySelector('a');
        if (link) link.setAttribute('href', targetUrl(short));
        added = true;
        continue;
      }
      if (row.parentNode) {
        row.parentNode.insertBefore(makeClone(row, short), row.nextSibling);
        added = true;
        console.info('[PteroBackups] Botón "' + LABEL + '" añadido al menú (junto a ' + (row.tagName || '?') + ').');
      }
    }

    if (!added) {
      tries++;
      if (tries % 8 === 0) {
        console.warn('[PteroBackups] Aún no se encuentra la fila "Files" del menú (intentos: ' + tries + ').');
      }
      ensureFloating(short);
    } else {
      var f = document.getElementById('pb-float');
      if (f) f.remove();
    }
  }

  try {
    var observer = new MutationObserver(function () { inject(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* sin observer, el intervalo lo cubre */ }
  setInterval(inject, 1200);
  inject();
})();
