// PteroBackups - inject.js (v3)
// Anade la opcion "Backup 2.0" al menu lateral de cada servidor SIN
// recompilar el panel. Clona la fila "Files" del menu del tema activo
// (panel normal, Arix, etc.) y la convierte en el enlace a Backup 2.0.
// No usa boton flotante ni anade nada fuera del menu.
(function () {
  'use strict';

  var LABEL = 'Backup 2.0';

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

  function rowFor(el, text) {
    var row = el;
    while (row.parentElement) {
      var pt = (row.parentElement.textContent || '').trim().toLowerCase();
      if (pt !== text) break;
      row = row.parentElement;
    }
    return row;
  }

  function findFilesRows(short) {
    var rows = [];
    var seen = [];
    var anchors = queryAllDeep('a[href$="/server/' + short + '/files"]');
    var more = queryAllDeep('a[href*="/server/' + short + '/files"]');
    for (var k = 0; k < more.length; k++) anchors.push(more[k]);

    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.closest('.pb-nav-clone')) continue;
      // Solo el enlace "Files" que vive dentro de un menu de navegacion real
      // (nav/aside/sidebar). Asi evitamos clonar el boton de la barra del
      // File Manager y lo dejamos unicamente en el menu lateral.
      if (!a.closest('nav, aside, [class*="sidebar" i], [class*="navigation" i], [class*="menu" i], ul, [role="navigation"]')) {
        continue;
      }
      var row = rowFor(a, (a.textContent || '').trim().toLowerCase());
      if (seen.indexOf(row) === -1) { seen.push(row); rows.push(row); }
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
    if (el && el.className && typeof el.className === 'string') {
      el.className = el.className.replace(/\bactive\b/g, '').trim();
    }
    if (el && el.removeAttribute) el.removeAttribute('aria-current');
  }

  function makeClone(row, short) {
    var clone = row.cloneNode(true);
    clone.classList.add('pb-nav-clone');
    cleanActive(clone);
    var inner = clone.querySelectorAll('*');
    for (var i = 0; i < inner.length; i++) cleanActive(inner[i]);

    var a = clone.tagName === 'A' ? clone : clone.querySelector('a');
    if (a) a.setAttribute('href', targetUrl(short));

    setLabel(clone);

    clone.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      window.location.href = targetUrl(currentShort() || short);
    }, true);

    return clone;
  }

  function removeAllClones() {
    var clones = document.querySelectorAll('.pb-nav-clone');
    for (var i = 0; i < clones.length; i++) clones[i].remove();
  }

  function inject() {
    var short = currentShort();

    if (!short) {
      removeAllClones();
      return;
    }

    var rows = findFilesRows(short);

    if (!rows.length) {
      removeAllClones();
      return;
    }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var next = row.nextElementSibling;
      if (next && next.classList && next.classList.contains('pb-nav-clone')) {
        var link = next.tagName === 'A' ? next : next.querySelector('a');
        if (link) link.setAttribute('href', targetUrl(short));
        continue;
      }
      if (row.parentNode) {
        row.parentNode.insertBefore(makeClone(row, short), row.nextSibling);
      }
    }
  }

  try {
    var observer = new MutationObserver(function () { inject(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(inject, 1200);
  inject();
})();
