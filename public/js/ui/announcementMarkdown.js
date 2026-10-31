// Popup-only Markdown, deliberately a small GFM subset rendered straight to Preact elements: no HTML is ever
// injected, every string is a text child (so Preact escapes it), and links/images pass an allowlist. Written here
// instead of vendoring `marked` (which this fork does not depend on) — the token surface is what keeps it safe.
import { h } from '../../vendor/preact.module.js';
import { POPUP_MAX_TEXT, validAnnouncementUrl } from '../../../shared/announcements.js';

const MAX_NODES = 4096;
const MAX_DEPTH = 8;

/** HTTP(S) without credentials, or a same-origin root path; never protocol-relative / data: / javascript: / blob:. */
export function popupContentUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return validAnnouncementUrl(value) ? value : null;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const unescapeEntities = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  const key = entity.toLowerCase();
  if (!key.startsWith('#')) return named[key] || raw;
  const cp = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
});

const LINK = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/;

/** Inline spans: code, strong, em, strike, links, images, escapes. Anything else is literal text. */
function inline(source, budget, depth = 0) {
  const out = [];
  let text = '';
  const flush = () => { if (text) { out.push(unescapeEntities(text)); text = ''; } };
  const push = (node) => { flush(); out.push(node); };
  let rest = String(source ?? '');
  while (rest) {
    if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) { text += rest; break; }
    const code = /^`([^`]+)`/.exec(rest);
    if (code) { push(h('code', null, code[1])); rest = rest.slice(code[0].length); continue; }
    const image = IMAGE.exec(rest);
    if (image) {
      const src = popupContentUrl(unescapeEntities(image[2]));
      const alt = unescapeEntities(image[1]);
      if (src) push(h('img', { src, alt, title: image[3] ? unescapeEntities(image[3]) : undefined, loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' }));
      else text += alt;
      rest = rest.slice(image[0].length); continue;
    }
    const link = LINK.exec(rest);
    if (link) {
      const href = popupContentUrl(unescapeEntities(link[2]));
      const body = inline(unescapeEntities(link[1]), budget, depth + 1);
      if (href) push(h('a', { href, title: link[3] ? unescapeEntities(link[3]) : undefined, target: '_blank', rel: 'noopener noreferrer' }, body));
      else out.push(...body);
      rest = rest.slice(link[0].length); continue;
    }
    const strong = /^(?:\*\*|__)([\s\S]+?)(?:\*\*|__)/.exec(rest);
    if (strong) { push(h('strong', null, inline(strong[1], budget, depth + 1))); rest = rest.slice(strong[0].length); continue; }
    const strike = /^~~([\s\S]+?)~~/.exec(rest);
    if (strike) { push(h('del', null, inline(strike[1], budget, depth + 1))); rest = rest.slice(strike[0].length); continue; }
    const em = /^(?:\*|_)([^*_\s][\s\S]*?)(?:\*|_)/.exec(rest);
    if (em) { push(h('em', null, inline(em[1], budget, depth + 1))); rest = rest.slice(em[0].length); continue; }
    const escaped = /^\\([\\`*_{}\[\]()#+\-.!>~|])/.exec(rest);
    if (escaped) { text += escaped[1]; rest = rest.slice(escaped[0].length); continue; }
    text += rest[0]; rest = rest.slice(1);
  }
  flush();
  return out;
}

const LIST_ITEM = /^\s*(?:[-*+]|(\d+)[.)])\s+/;

/** Block structure: fenced code, headings, quotes, lists, rules, paragraphs (blank lines separate). */
export function renderAnnouncementMarkdown(source) {
  const text = typeof source === 'string' ? source : '';
  const plain = () => h('p', { class: 'announcement-content__plain' }, text);
  if ([...text].length > POPUP_MAX_TEXT) return plain();
  const budget = { nodes: 0 };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  try {
    while (i < lines.length) {
      if (++budget.nodes > MAX_NODES) throw new Error('node limit');
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = /^\s*```([^\s`]*)\s*$/.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++; // the closing fence (or EOF)
        blocks.push(h('pre', null, h('code', null, body.join('\n'))));
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        blocks.push(h(`h${heading[1].length}`, null, inline(heading[2].trim(), budget)));
        i++; continue;
      }
      if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) { blocks.push(h('hr', null)); i++; continue; }
      if (/^\s*>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
        blocks.push(h('blockquote', null, renderBlocks(quoted, budget)));
        continue;
      }
      if (LIST_ITEM.test(line)) {
        const ordered = !!LIST_ITEM.exec(line)[1];
        const items = [];
        while (i < lines.length && LIST_ITEM.test(lines[i])) {
          const item = [lines[i++].replace(LIST_ITEM, '')];
          while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && !/^\s*(?:#{1,6}>|```)/.test(lines[i])) {
            item.push(lines[i++]);
          }
          items.push(h('li', null, inline(item.join(' ').trim(), budget)));
          if (++budget.nodes > MAX_NODES) throw new Error('node limit');
        }
        blocks.push(h(ordered ? 'ol' : 'ul', null, items));
        continue;
      }
      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(?:```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|---|\*\*\*|___)/.test(lines[i])) {
        paragraph.push(lines[i++]);
      }
      paragraphs(paragraph, budget).forEach((node) => blocks.push(node));
    }
  } catch (err) { if (globalThis.process?.env?.SP_MD_DEBUG) console.error(err); return plain(); }
  return h('div', { class: 'announcement-markdown' }, blocks);
}

/** A paragraph keeps its line breaks (announcements are written in a text box, not by a Markdown author). */
function paragraphs(lines, budget) {
  const out = [];
  const parts = [];
  lines.forEach((line, index) => {
    if (index) parts.push(h('br', null));
    parts.push(...inline(line, budget));
  });
  if (parts.length) out.push(h('p', null, parts));
  return out;
}

/** Nested blocks (a quote): shares the node budget with the outer document. */
function renderBlocks(lines, budget) {
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (++budget.nodes > MAX_NODES) throw new Error('node limit');
    out.push(h('p', null, inline(line, budget)));
  }
  return out;
}

export { ESCAPES };
