// PteroBackups - inject.js
// Añade la opción "Backup 2.0" al menú lateral de cada servidor SIN
// recompilar el panel: busca el botón "Files" del menú y lo CLONA, así copia
// exactamente el diseño del tema activo (panel normal, Arix v2, etc.).
(function () {
  'use strict';

  var LABEL = 'Backup 2.0';
  var announced = false;
  var warnTimer = null;

  function currentShort() {
    var m = window.location.pathname.match(/^\/server\/([a-zA-Z0-9]{8})/);
    return m ? m[1] : null;
  }

  function targetUrl(short) {
    return '/pterobackups/server/' + short;
  }

  function setLabel(root) {
    var replaced = false;
    var els = root.querySelectorAll('span, p, div, strong, b, a');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length === 0 && el.textContent.trim()) {
        el.textContent = LABEL;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      var walker = root.childNodes;
      for (var j = 0; j < walker.length; j++) {
        var n = walker[j];
        if (n.nodeType === 3 && n.textContent.trim()) {
          n.textContent = ' ' + LABEL;
          replaced = true;
          break;
        }
      }
    }
    if (!replaced) root.textContent = LABEL;
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
    var nodes = document.querySelectorAll('a, button, [role="link"], [role="button"], li');
    for (var j = 0; j < nodes.length; j++) {
      var t = (nodes[j].textContent || '').trim().toLowerCase();
      if (t && texts.indexOf(t) !== -1) return nodes[j];
    }
    return null;
  }

  function cleanActive(el) {
    if (el.className && typeof el.className === 'string') {
      el.className = el.className.replace(/\bactive\b/g, '').trim();
    }
    el.removeAttribute && el.removeAttribute('aria-current');
  }

  function inject() {
    var short = currentShort();
    var existing = document.getElementById('pb-nav-item');

    // Fuera de la vista de un servidor: quitar el botón si quedó de antes
    if (!short) {
      if (existing) existing.remove();
      return;
    }

    // Ya existe: solo asegurar que apunta al servidor actual
    if (existing) {
      var link = existing.tagName === 'A' ? existing : existing.querySelector('a');
      if (link) link.setAttribute('href', targetUrl(short));
      return;
    }

    var found = findMenuItem(short);
    if (!found) {
      if (!warnTimer) {
        warnTimer = setTimeout(function () {
          if (!document.getElementById('pb-nav-item')) {
            console.warn('[PteroBackups] No se encontró el menú del servidor para añadir "' + LABEL + '".');
          }
        }, 8000);
      }
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
    if (!announced) {
      announced = true;
      console.info('[PteroBackups] Botón "' + LABEL + '" añadido al menú del servidor.');
    }
  }

  // El panel (y Arix) renderizan el menú con React de forma asíncrona y al
  // navegar no recargan la página: vigilamos los cambios del DOM.
  try {
    var observer = new MutationObserver(function () { inject(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* sin observer, el intervalo lo cubre */ }
  setInterval(inject, 1200);
  inject();
})();
