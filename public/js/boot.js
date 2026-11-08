// Static boot diagnostics: CSP allows external scripts, never inline event handlers.
// i18n-ignore-file: pre-module legacy-browser fallback, as public/index.html.
// Boot diagnostics (plain ES5: runs everywhere). A browser too old for the app says so instead of spinning forever:
    // no ES modules (nomodule below), a module graph that cannot load (e.g. import maps: Safari / iOS < 16.4), or no
    // boot after 9 s.
    var BOOT_RETRIES = 4, BOOT_RETRY_MS = 5000, BOOT_RETRY_FORGET_MS = 120000, bootRetrying = false;
    window.__spBootRetry = function () {
      if (bootRetrying) return true;
      var n = 0, now = Date.now();
      try {
        var saved = JSON.parse(sessionStorage.getItem('sp.bootRetry') || 'null');
        if (saved && now - saved.at < BOOT_RETRY_FORGET_MS) n = saved.n;
        if (n >= BOOT_RETRIES) return false;
        sessionStorage.setItem('sp.bootRetry', JSON.stringify({ n: n + 1, at: now }));
      } catch (_x) { return false; }
      bootRetrying = true;
      setTimeout(function () { location.reload(); }, BOOT_RETRY_MS);
      return true;
    };
    window.__spBootFail = function (why) {
      var e = document.getElementById('boot-err');
      if (!e || e.getAttribute('data-final')) return;
      var im;
      try { im = !!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('importmap')); } catch (_x) { im = false; }
      // A script that fails to load in a browser that can run the game is usually a release in progress or a network blip:
      // try again by itself a few times (the same tab, 5 s apart; the count forgets itself after 2 min) before it stops here.
      if (why !== 'old' && im && window.__spBootRetry()) {
        e.textContent = '正在重新加载游戏脚本…';
        return;
      }
      e.textContent = why === 'old' || !im
        ? '当前浏览器版本过旧，无法运行本游戏。请升级到 iOS / iPadOS 16.4+（Safari 16.4+）、Chrome / Edge 90+ 或 Firefox 108+ 后刷新。'
        : '游戏脚本加载失败，请检查网络连接后刷新页面。';
      e.setAttribute('data-final', '1');
    };
    // a module graph that fails to link (bare specifier without import-map support) reports here, not on the <script>
    window.addEventListener('error', function (ev) {
      var b = document.getElementById('boot');
      if (!b || b.classList.contains('is-done')) return;
      if (/specifier|resolve|import|module/i.test(String(ev && ev.message))) window.__spBootFail('load');
    });
  
// If modules never boot (very old browser / blocked script), explain instead of spinning forever.
    setTimeout(function () {
      var b = document.getElementById('boot'), e = document.getElementById('boot-err');
      if (b && !b.classList.contains('is-done') && e && !e.textContent) e.textContent = '加载时间较长…如长时间无响应，请使用最新版 Chrome / Edge / Safari / Firefox 并刷新页面。';
    }, 9000);
  
document.addEventListener('error', function (event) {
  if (event.target && event.target.id === 'sp-main') window.__spBootFail('load');
}, true);
