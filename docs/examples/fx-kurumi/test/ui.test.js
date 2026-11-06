import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('margin frame shows negative net balance while preserving cash and outstanding loss', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  const root = { innerHTML: '' };
  let onMessage;
  vm.runInNewContext(script, {
    document: { getElementById: () => root },
    window: { addEventListener: (event, fn) => { if (event === 'message') onMessage = fn; } },
    parent: { postMessage() {} },
  });
  for (const [cash, owed, net] of [[0, 5, -5], [2, 5, -3], [1, 0, 1], [0, 0, 0]]) {
    onMessage({ data: { v: 1, t: 'state', private: {
      bandId: 'band_x_fx_kurumi_margin', funds: cash, counters: { 'kurumi:unpaidLoss': owed },
    } } });
    assert.match(root.innerHTML, new RegExp('净余额</span><b[^>]*>' + net + '</b>'));
    if (owed > 0) {
      assert.match(root.innerHTML, new RegExp('可用现金</span><b[^>]*>' + cash + '</b>'));
      assert.match(root.innerHTML, new RegExp('待补亏损</span><b[^>]*>' + owed + '</b>'));
    } else assert.ok(!root.innerHTML.includes('待补亏损'));
  }
});
