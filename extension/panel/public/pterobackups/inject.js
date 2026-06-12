// PteroBackups - inject.js
// Añade la opción "Backup 2.0" al menú lateral de cada servidor SIN
// recompilar el panel (la forma oficial requiere yarn build y eso rompe los
// temas como Arix). Estrategia:
//   1) Clonar el botón "Files" del tema activo (copia su diseño exacto).
//   2) Si el tema no se deja detectar, crear un botón flotante propio.
(function () {
  'use strict';

  console.info('[PteroBackups] inject.js cargado correctamente.');

  var LABEL = 'Backup 2.0';
  var FLOAT_DELAY = 2500;
  var startedAt = Date.now();
  var announced = false;

  function currentShort() {
    var m = window.location.pathname.match(/\/server\/([a-zA-Z0-9-]{4,40})(\/|$)/);
    if (m) return m[1];
    // Respaldo: deducirlo de los enlaces del menu de la pagina
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

  function setLabel(root) {
    var els = root.querySelectorAll('span, p, div, strong, b, a');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length === 0 && el.textContent.trim()) {
        el.textContent = LABEL;
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

  // Busca el elemento del menú a clonar. Primero por enlace (panel normal),
  // después por el TEXTO visible (temas como Arix que arman el menú distinto).
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
    var nodes = document.querySelectorAll('a, button, li, span, p, div, [role="link"], [role="button"]');
    for (var j = 0; j < nodes.length; j++) {
      var t = (nodes[j].textContent || '').trim().toLowerCase();
      if (!t || texts.indexOf(t) === -1) continue;
      return nodes[j].closest('a, button, li') || nodes[j];
    }
    return null;
  }

  function cleanActive(el) {
    if (el.className && typeof el.className === 'string') {
      el.className = el.className.replace(/\bactive\b/g, '').trim();
    }
    if (el.removeAttribute) el.removeAttribute('aria-current');
  }

  // Plan B: botón flotante propio si el menú del tema no se deja clonar
  function ensureFloating(short) {
    var f = document.getElementById('pb-float');
    if (document.getElementById('pb-nav-item')) {
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
    console.info('[PteroBackups] Menú del tema no detectado: botón flotante "' + LABEL + '" añadido.');
  }

  function inject() {
    var short = currentShort();
    var navItem = document.getElementById('pb-nav-item');
    var floatBtn = document.getElementById('pb-float');

    // Fuera de la vista de un servidor: limpiar
    if (!short) {
      if (navItem) navItem.remove();
      if (floatBtn) floatBtn.remove();
      return;
    }

    // Ya existe en el menú: solo apuntar al servidor actual
    if (navItem) {
      var link = navItem.tagName === 'A' ? navItem : navItem.querySelector('a');
      if (link) link.setAttribute('href', targetUrl(short));
      if (floatBtn) floatBtn.remove();
      return;
    }

    var found = findMenuItem(short);
    if (!found) {
      ensureFloating(short);
      return;
    }

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

    // Navegación garantizada aunque el tema use botones de React sin enlace
    clone.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      window.location.href = targetUrl(currentShort() || short);
    }, true);

    base.parentNode.insertBefore(clone, base.nextSibling);
    if (floatBtn) floatBtn.remove();
    if (!announced) {
      announced = true;
      console.info('[PteroBackups] Botón "' + LABEL + '" añadido al menú del servidor.');
    }
  }

  try {
    var observer = new MutationObserver(function () { inject(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* sin observer, el intervalo lo cubre */ }
  setInterval(inject, 1200);
  inject();
})();
