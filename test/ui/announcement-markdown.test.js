// The popup Markdown subset (ui/announcementMarkdown.js): no injected HTML, no attribute/style/event surface, and a
// link or image URL only from the allowlist. The renderer emits Preact VNodes, so every string is a text child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAnnouncementMarkdown, popupContentUrl } from '../../public/js/ui/announcementMarkdown.js';
import { POPUP_MAX_TEXT } from '../../shared/announcements.js';

const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes)
  : node == null || node === false ? []
    : typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [node];
const types = (tree) => nodes(tree).filter((n) => typeof n === 'object').map((n) => n.type);
const textOf = (tree) => nodes(tree).map((n) => (typeof n === 'string' ? n : '')).join('');

test('blocks: headings, lists, quotes, code fences, rules and paragraphs', () => {
  const tree = renderAnnouncementMarkdown(['# 标题', '', '- 一', '- 二', '', '> 引用', '', '```js', 'const a = 1;', '```', '', '---', '', '正文'].join('\n'));
  assert.deepEqual(types(tree).slice(0, 2), ['div', 'h1']);
  const all = types(tree);
  for (const t of ['ul', 'blockquote', 'pre', 'code', 'hr', 'p']) assert.ok(all.includes(t), t);
  assert.equal(types(tree).filter((t) => t === 'li').length, 2);
});

test('inline: bold, emphasis, inline code, strike, link and image', () => {
  const tree = renderAnnouncementMarkdown('**粗** *斜* `码` ~~删~~ [链接](https://example.com/a) ![图](/assets/x.png)');
  const all = types(tree);
  for (const t of ['strong', 'em', 'code', 'del', 'a', 'img']) assert.ok(all.includes(t), t);
  const link = nodes(tree).find((n) => n.type === 'a');
  assert.equal(link.props.href, 'https://example.com/a');
  assert.equal(link.props.target, '_blank');
  assert.equal(link.props.rel, 'noopener noreferrer');
  const img = nodes(tree).find((n) => n.type === 'img');
  assert.equal(img.props.src, '/assets/x.png');
});

test('content can never inject markup or an attribute: HTML stays text, unsafe URLs are dropped', () => {
  const tree = renderAnnouncementMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.equal(types(tree).includes('script'), false);
  assert.equal(types(tree).includes('img'), false);
  assert.match(textOf(tree), /<script>alert\(1\)<\/script>/);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', 'https://u:p@example.com/x', 'blob:https://x/1']) {
    assert.equal(popupContentUrl(bad), null, bad);
    const link = renderAnnouncementMarkdown(`[x](${bad})`);
    assert.equal(types(link).includes('a'), false, bad);
    const image = renderAnnouncementMarkdown(`![x](${bad})`);
    assert.equal(types(image).includes('img'), false, bad);
  }
  assert.equal(popupContentUrl('/notice'), '/notice');
  assert.equal(popupContentUrl('https://example.com/notice'), 'https://example.com/notice');
});

test('oversized content degrades to one plain paragraph instead of a parse storm', () => {
  const tree = renderAnnouncementMarkdown('x'.repeat(POPUP_MAX_TEXT + 1));
  assert.deepEqual(types(tree).slice(1), []);
  assert.equal(tree.props.class, 'announcement-content__plain');
});
