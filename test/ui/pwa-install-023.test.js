import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPwaInstall } from '../../public/js/pwa.js';
function rig(standalone = false) {
  const win = new EventTarget(), display = new EventTarget();
  display.matches = standalone;
  win.matchMedia = () => display;
  const pwa = createPwaInstall(win);
  const offer = (outcome = 'dismissed', fail = false) => {
    let calls = 0;
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = async () => { calls++; if (fail) throw Error('unavailable'); return { outcome }; };
    win.dispatchEvent(e);
    return { calls: () => calls, e };
  };
  return { pwa, win, display, offer };
}
test('install offer is consumed even on dismissal, duplicate clicks, or rejected prompt', async () => {
  const { pwa, offer } = rig();
  const states = []; const off = pwa.subscribe((x) => states.push(x));
  assert.equal(pwa.available(), false);
  const first = offer();
  assert.equal(first.e.defaultPrevented, true);
  assert.equal(pwa.available(), true);
  const a = pwa.request(), b = pwa.request();
  assert.equal(await a, false); assert.equal(await b, false); assert.equal(first.calls(), 1);
  const broken = offer('accepted', true);
  assert.equal(await pwa.request(), false); assert.equal(await pwa.request(), false); assert.equal(broken.calls(), 1);
  const next = offer('accepted');
  assert.equal(await pwa.request(), true); assert.equal(next.calls(), 1);
  assert.deepEqual(states, [false, true, false, true, false, true, false]);
  off(); pwa.dispose();
});
test('installed / standalone hides stale offers; disposing removes listeners', async () => {
  const { pwa, win, display, offer } = rig();
  offer(); display.matches = true; display.dispatchEvent(new Event('change'));
  assert.equal(pwa.available(), false); assert.equal(await pwa.request(), false);
  display.matches = false; win.dispatchEvent(new Event('appinstalled')); offer();
  assert.equal(pwa.available(), false);
  pwa.dispose();
  assert.equal(offer().e.defaultPrevented, false);
  const native = rig(true); native.offer(); assert.equal(native.pwa.available(), false); native.pwa.dispose();
});
test('manifest uses actual 192/512 icons shipped outside optional game assets', () => {
  const m = JSON.parse(readFileSync(new URL('../../public/manifest.json', import.meta.url)));
  assert.equal(m.start_url, '/'); assert.equal(m.scope, '/');
  for (const icon of m.icons) {
    assert.ok(icon.src.startsWith('/icons/'));
    const bytes = readFileSync(new URL('../../public' + icon.src, import.meta.url));
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
  }
});
