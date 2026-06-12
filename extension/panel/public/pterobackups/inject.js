// PteroBackups - inject.js
// Añade la opción "Copias Remotas" al menú lateral de cada servidor SIN
// recompilar el panel: busca el botón "Files" del menú y lo CLONA, así copia
// exactamente el diseño del tema activo (panel normal, Arix v2, etc.).
(function () {
  'use strict';

  var LABEL = 'Copias Remotas';

  function currentShort() {
    var m = window.location.pathname.match(/^\/server\/([a-zA-Z0-9]{8})/);
    return m ? m[1] : null;
  }

  function setLabel(a) {
    var replaced = false;
    var els = a.querySelectorAll('span, p, div');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!replaced && el.children.length === 0 && el.textContent.trim()) {
        el.textContent = LABEL;
        replaced = true;
      }
    }
    if (!replaced) {
      for (var j = 0; j < a.childNodes.length; j++) {
        var n = a.childNodes[j];
        if (n.nodeType === 3 && n.textContent.trim()) {
          n.textContent = ' ' + LABEL;
          replaced = true;
          break;
        }
      }
    }
    if (!replaced) a.textContent = LABEL;
    a.setAttribute('title', LABEL);
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
      if (link) link.setAttribute('href', '/pterobackups/server/' + short);
      return;
    }

    // Busca el enlace de "Files" del menú del servidor actual
    var files = document.querySelector('a[href$="/server/' + short + '/files"]') ||
      document.querySelector('a[href="/server/' + short + '/files"]');
    if (!files) return;

    var item = files.closest('li') || files;
    var clone = item.cloneNode(true);
    clone.id = 'pb-nav-item';

    var a = clone.tagName === 'A' ? clone : clone.querySelector('a');
    if (!a) return;
    a.setAttribute('href', '/pterobackups/server/' + short);
    a.removeAttribute('aria-current');
    if (a.className) a.className = a.className.replace(/\bactive\b/g, '').trim();

    setLabel(a);
    item.parentNode.insertBefore(clone, item.nextSibling);
  }

  // El panel (y Arix) renderizan el menú con React de forma asíncrona y al
  // navegar no recargan la página: vigilamos los cambios del DOM.
  try {
    var observer = new MutationObserver(function () { inject(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* sin observer, el intervalo lo cubre */ }
  setInterval(inject, 1500);
  inject();
})();
