// PteroBackups - inject.js (v4)
// Anade la opcion "Backup 2.0" al menu lateral de cada servidor SIN
// recompilar el panel. Clona la fila "Files" del menu del tema activo
// (panel normal, Arix, etc.) y la convierte en el enlace a Backup 2.0.
// No usa boton flotante ni anade nada fuera del menu.
//
// v4 (rendimiento): antes este script escaneaba TODOS los elementos de la
// pagina en cada mutacion del DOM, y como el propio script inserta nodos se
// realimentaba a si mismo. En moviles (sobre todo en "modo escritorio", donde
// el panel dibuja muchisimos mas elementos) eso saturaba la CPU y dejaba al
// navegador sin recursos para resolver el reto de Cloudflare. Ahora el trabajo
// se agrupa, se ignoran las mutaciones propias, el escaneo profundo solo se
// hace si hace falta y todo se detiene con la pestana en segundo plano.
(function () {
  'use strict';

  var LABEL = 'Backup 2.0';
  var scheduled = false;   // ya hay un inject() pendiente
  var busy = false;        // estamos modificando el DOM nosotros mismos
  var lastDeepScan = 0;    // ultimo escaneo del shadow DOM (ms)
  var DEEP_SCAN_EVERY = 3000;

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

  // Escaneo profundo (shadow DOM). Es lo mas caro que hace este script, asi
  // que solo se usa cuando la busqueda normal no encuentra nada y como mucho
  // una vez cada DEEP_SCAN_EVERY ms.
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
    var sel = 'a[href*="/server/' + short + '/files"]';

    // 1) Busqueda normal (barata). Cubre el panel estandar y los temas
    //    habituales, que no usan shadow DOM.
    var anchors = [];
    var plain = document.querySelectorAll(sel);
    for (var p = 0; p < plain.length; p++) anchors.push(plain[p]);

    // 2) Solo si no aparecio nada, probamos dentro del shadow DOM.
    if (!anchors.length) {
      var now = Date.now();
      if (now - lastDeepScan >= DEEP_SCAN_EVERY) {
        lastDeepScan = now;
        anchors = queryAllDeep(sel);
      }
    }

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
    // Fuera de las paginas de servidor no hay nada que hacer: salimos antes
    // de tocar el DOM para no gastar CPU en el resto del panel.
    var short = currentShort();

    if (!short) {
      if (document.querySelector('.pb-nav-clone')) removeAllClones();
      return;
    }

    var rows = findFilesRows(short);

    if (!rows.length) {
      if (document.querySelector('.pb-nav-clone')) removeAllClones();
      return;
    }

    busy = true; // ignora las mutaciones que provoquemos nosotros
    try {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var next = row.nextElementSibling;
        if (next && next.classList && next.classList.contains('pb-nav-clone')) {
          var link = next.tagName === 'A' ? next : next.querySelector('a');
          if (link && link.getAttribute('href') !== targetUrl(short)) {
            link.setAttribute('href', targetUrl(short));
          }
          continue;
        }
        if (row.parentNode) {
          row.parentNode.insertBefore(makeClone(row, short), row.nextSibling);
        }
      }
    } finally {
      // Se libera en el siguiente ciclo para que las mutaciones propias ya
      // hayan llegado al observer.
      setTimeout(function () { busy = false; }, 0);
    }
  }

  // Agrupa las rafagas de mutaciones en una sola pasada.
  function scheduleInject() {
    if (scheduled || busy) return;
    if (document.hidden) return; // en segundo plano no gastamos CPU
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      try { inject(); } catch (e) {}
    }, 250);
  }

  try {
    var observer = new MutationObserver(scheduleInject);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // Red de seguridad por si alguna navegacion interna no genera mutaciones.
  setInterval(function () {
    if (!document.hidden) scheduleInject();
  }, 3000);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) scheduleInject();
  });

  scheduleInject();
})();
