(() => {
  'use strict';
  // Deliberately small Markdown subset. All untrusted text enters text nodes, never an HTML parser.
  function safeLink(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return;
    try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return url.href; } catch {}
  }
  function node(tag, text, parent) {
    const item = document.createElement(tag); if (text) item.textContent = text; parent.append(item); return item;
  }
  function inline(text, parent, openLink, depth = 0) {
    if (depth > 8) { parent.append(document.createTextNode(text)); return; }
    const pattern = /(`+)([^`\n]+)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
    let from = 0, match;
    while ((match = pattern.exec(text))) {
      parent.append(document.createTextNode(text.slice(from, match.index)));
      if (match[2]) node('code', match[2], parent);
      else if (match[3]) {
        const href = safeLink(match[4]);
        if (href) {
          const link = node('a', match[3], parent); link.href = href; link.rel = 'noopener noreferrer';
          link.onclick = event => { event.preventDefault(); openLink(href); };
        } else parent.append(document.createTextNode(match[3]));
      } else inline(match[5] || match[6] || match[7] || match[8], node(match[5] || match[6] ? 'strong' : 'em', '', parent), openLink, depth + 1);
      from = pattern.lastIndex;
    }
    parent.append(document.createTextNode(text.slice(from)));
  }
  // Keep matching DOM elements (including focused links/Copy buttons) alive during deltas.
  function reconcile(parent, next) {
    const wanted = [...next.childNodes];
    for (let index = 0; index < wanted.length; index++) {
      const incoming = wanted[index], existing = parent.childNodes[index];
      if (!existing) { parent.append(incoming); continue; }
      if (existing.nodeType !== incoming.nodeType || existing.nodeName !== incoming.nodeName) { existing.replaceWith(incoming); continue; }
      if (incoming.nodeType === Node.TEXT_NODE) { if (existing.textContent !== incoming.textContent) existing.textContent = incoming.textContent; continue; }
      for (const attr of [...existing.attributes]) if (!incoming.hasAttribute(attr.name)) existing.removeAttribute(attr.name);
      for (const attr of [...incoming.attributes]) if (existing.getAttribute(attr.name) !== attr.value) existing.setAttribute(attr.name, attr.value);
      existing.onclick = incoming.onclick;
      reconcile(existing, incoming);
    }
    while (parent.childNodes.length > wanted.length) parent.lastChild.remove();
  }
  function render(text, parent, actions) {
    const fragment = document.createDocumentFragment();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let index = 0;
    const block = line => /^\s*(`{3,}|~{3,})|^#{1,6}\s|^\s*([-+*]|\d+\.)\s|^\s*>\s?/.test(line);
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      const fence = line.match(/^\s*(`{3,}|~{3,})([^\s]*)\s*$/);
      if (fence) {
        index++; const code = [];
        while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index++;
        const wrapper = node('div', '', fragment); wrapper.className = 'code-block';
        const bar = node('div', '', wrapper); bar.className = 'code-bar';
        node('span', /^[a-zA-Z0-9_+-]{1,30}$/.test(fence[2]) ? fence[2] : 'Code', bar);
        const copy = node('button', 'Copy', bar); copy.type = 'button'; copy.setAttribute('aria-label', 'Copy code');
        copy.onclick = async event => {
          const button = event.currentTarget;
          try { await actions.copy(code.join('\n')); button.textContent = 'Copied'; } catch { button.textContent = 'Copy failed'; }
        };
        const pre = node('pre', '', wrapper); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Code block'); node('code', code.join('\n'), pre);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { inline(heading[2], node(`h${Math.min(6, heading[1].length + 2)}`, '', fragment), actions.openLink); index++; continue; }
      const list = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
      if (list) {
        const ordered = /\d/.test(list[1]); const ul = node(ordered ? 'ol' : 'ul', '', fragment);
        if (ordered) ul.start = parseInt(list[1], 10);
        while (index < lines.length) {
          const item = lines[index].match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
          if (!item || /\d/.test(item[1]) !== ordered) break;
          const li = node('li', '', ul); inline(item[2], li, actions.openLink); index++;
          while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !block(lines[index])) { li.append(document.createTextNode('\n')); inline(lines[index++].trim(), li, actions.openLink); }
        }
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = node('blockquote', '', fragment); inline(line.replace(/^\s*>\s?/, ''), quote, actions.openLink); index++; continue;
      }
      const paragraph = [lines[index++]];
      while (index < lines.length && lines[index].trim() && !block(lines[index])) paragraph.push(lines[index++]);
      inline(paragraph.join('\n'), node('p', '', fragment), actions.openLink);
    }
    reconcile(parent, fragment);
  }
  window.nxMarkdown = Object.freeze({ render, safeLink });
})();
