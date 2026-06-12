// PteroBackups - admin-inject.js
// Añade el enlace "PteroBackups" al menú del área admin clonando el enlace de
// "Nodes", para que adopte el diseño del tema que esté instalado.
(function () {
  'use strict';

  function inject() {
    if (document.getElementById('pb-admin-nav')) return;
    var target = document.querySelector('a[href$="/admin/nodes"]');
    if (!target) return;

    var item = target.closest('li') || target;
    var clone = item.cloneNode(true);
    clone.id = 'pb-admin-nav';

    var a = clone.tagName === 'A' ? clone : clone.querySelector('a');
    if (!a) return;
    a.setAttribute('href', '/admin/pterobackups');
    if (a.className) a.className = a.className.replace(/\bactive\b/g, '').trim();
    if (item.className) clone.className = (clone.className || '').replace(/\bactive\b/g, '').trim();

    var replaced = false;
    var els = a.querySelectorAll('span, p, div');
    for (var i = 0; i < els.length; i++) {
      if (!replaced && els[i].children.length === 0 && els[i].textContent.trim()) {
        els[i].textContent = 'PteroBackups';
        replaced = true;
      }
    }
    if (!replaced) {
      for (var j = 0; j < a.childNodes.length; j++) {
        var n = a.childNodes[j];
        if (n.nodeType === 3 && n.textContent.trim()) {
          n.textContent = ' PteroBackups';
          replaced = true;
          break;
        }
      }
    }
    a.setAttribute('title', 'PteroBackups');

    item.parentNode.insertBefore(clone, item.nextSibling);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
  setInterval(inject, 2000);
})();
