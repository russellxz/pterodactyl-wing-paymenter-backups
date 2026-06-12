// PteroBackups - inject.js (v3)
// Añade "Backup 2.0" al menú lateral de cada servidor SIN recompilar el panel.
// 1) Intenta CLONAR el botón "Files" del tema activo (panel normal, Arix...).
// 2) Si el tema no lo permite, muestra un botón flotante abajo a la derecha.
(function () {
  'use strict';

  var LABEL = 'Backup 2.0';
  var announced = false;
  var serverSince = 0;
  var lastShort = null;

  function currentShort() {
    var m = window.location.pathname.match(/^\/server\/([a-zA-Z0-9]{8})/);
    return m ? m[1] : null;
  }

  function targetUrl(short) {
    return '/pterobackups/server/' + short;
  }

  function setLabel(root) {
    try {
      var els = root.querySelectorAll('span, p, div, strong, b');
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
      root.appendChild(document.createTextNode(' ' + LABEL));
    } catch (e) { /* nada */ }
  }

  // Busca el elemento del menú a clonar: primero por enlace, luego por texto.
  function findMenuItem(short) {
    var selectors = [
      'a[href$="/server/' + short + '/files"]',
      'a[href*="/server/' + short + '/files"]',
      'a[href$="/server/' + short + '/network"]',
      'a[href*="/server/' + short + '/network"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var a = document.querySelector(selectors[i]);
      if (a) return a;
    }
    var texts = ['files', 'archivos', 'file manager', 'gestor de archivos'];
    var nodes = document.querySelectorAll('a, button, [role="link"], [role="button"]');
    for (var j = 0; j < nodes.length; j++) {
      var t = (nodes[j].textContent || '').trim().toLowerCase();
      if (t && texts.indexOf(t) !== -1) return nodes[j];
    }
    return null;
  }

  function cleanActive(el) {
    try {
      if (el.className && typeof el.className === 'string') {
        el.className = el.className.replace(/\bactive\b/g, '').trim();
      }
      if (el.removeAttribute) el.removeAttribute('aria-current');
    } catch (e) { /* nada */ }
  }

  function injectMenu(short) {
    var existing = document.getElementById('pb-nav-item');
    if (existing) {
      var link = existing.tagName === 'A' ? existing : existing.querySelector('a');
      if (link) link.setAttribute('href', targetUrl(short));
      return true;
    }

    var found = findMenuItem(short);
    if (!found) return false;

    try {
      var base = found.closest('li') || found;
      var clone = base.cloneNode(true);
      clone.id = 'pb-nav-item';
      cleanActive(clone);

      var a = clone.tagName === 'A' ? clone : clone.querySelector('a');
      if (a) {
        a.setAttribute('href', targetUrl(short));
        cleanActive(a);
      }

      setLabel(clone);

      // Navegación garantizada aunque el tema use botones de React
      clone.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        window.location.href = targetUrl(currentShort() || short);
      }, true);

      base.parentNode.insertBefore(clone, base.nextSibling);
      if (!announced) {
        announced = true;
        console.info('[PteroBackups] Botón "' + LABEL + '" añadido al menú del servidor.');
      }
      return true;
    } catch (e) {
      console.warn('[PteroBackups] No se pudo clonar el menú: ' + e.message);
      return false;
    }
  }

  // Botón flotante de respaldo: aparece si en ~3 segundos no se pudo poner
  // el botón en el menú (por ejemplo, con menús que lo quitan al redibujar).
  function ensureFloat(short, menuOk) {
    var f = document.getElementById('pb-float');
    if (!short || menuOk) {
      if (f) f.remove();
      return;
    }
    if (Date.now() - serverSince < 3000) return;
    if (f) {
      f.setAttribute('href', targetUrl(short));
      if (!f.isConnected && document.body) document.body.appendChild(f);
      return;
    }
    f = document.createElement('a');
    f.id = 'pb-float';
    f.setAttribute('href', targetUrl(short));
    f.textContent = LABEL;
    f.setAttribute('style',
      'position:fixed;right:18px;bottom:18px;z-index:999999;' +
      'background:#0e1320;color:#ffb84d;border:1px solid #f0a33c;' +
      'border-radius:999px;padding:10px 18px;font:600 14px system-ui,sans-serif;' +
      'text-decoration:none;box-shadow:0 6px 18px rgba(0,0,0,0.45);cursor:pointer;');
    document.body.appendChild(f);
    console.info('[PteroBackups] Botón flotante "' + LABEL + '" mostrado.');
  }

  function tick() {
    try {
      var short = currentShort();
      if (short !== lastShort) {
        lastShort = short;
        serverSince = Date.now();
      }
      if (!short) {
        var item = document.getElementById('pb-nav-item');
        if (item) item.remove();
        var f = document.getElementById('pb-float');
        if (f) f.remove();
        return;
      }
      var menuOk = injectMenu(short);
      ensureFloat(short, menuOk);
    } catch (e) { /* nunca romper el panel */ }
  }

  console.info('[PteroBackups] inject.js cargado.');
  try {
    var observer = new MutationObserver(function () { tick(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* el intervalo lo cubre */ }
  setInterval(tick, 1000);
  tick();
})();
