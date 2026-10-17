// Device-side renderer diagnostics; no account, room, cookie or token is included in the report.
const output = document.getElementById('report');
const report = { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight, devicePixelRatio], messages: [] };
const show = () => { output.textContent = JSON.stringify(report, null, 2); };
const message = (...args) => {
  report.messages.push(args.map(value => value instanceof Error ? `${value.name}: ${value.message}`
    : typeof value === 'string' ? value : String(value)).join(' '));
  show();
};
const warn = console.warn;
console.warn = (...args) => { message(...args); warn.apply(console, args); };
addEventListener('error', event => message('error', event.message));
addEventListener('unhandledrejection', event => message('unhandledrejection', event.reason));
document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(output.textContent); document.getElementById('copy').textContent = '已复制'; }
  catch { message('复制失败，请长按结果文字复制。'); }
});
document.getElementById('retry').addEventListener('click', () => location.reload());
const started = performance.now();
const production = new URLSearchParams(location.search).has('production');
report.check = production ? '正式构建' : '源码引擎';
let liveView = null;
let heartbeat = setInterval(() => { report.elapsedMs = Math.round(performance.now() - started); show(); }, 1000);
try {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
  report.webgl = gl ? { version: gl.getParameter(gl.VERSION), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) } : null;
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  report.step = '加载游戏数据'; show();
  const { data } = await import('../js/data.js');
  await data.loadAll('assets', 'local', 'stages', 'chess', 'enemies', 'tokens', 'items');
  const { settingsStore } = await import('../js/ui/settings.js');
  report.quality = settingsStore.get().quality;
  report.step = '初始化战场渲染器'; show();
  const field = document.getElementById('field');
  let view;
  if (production) {
    field.style.height = `${innerHeight}px`;
    report.fieldSize = [field.clientWidth, field.clientHeight];
    const began = performance.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('正式构建渲染初始化超过30秒')), 30000);
    try {
      report.step = '加载正式构建的渲染文件'; show();
      const [mod, assetMod, hostMod] = await Promise.all([
        import('/build/assets/app-Ra5VbLJY.js'), import('/build/assets/assets-C7PwvnZN.js'), import('../js/ui/fieldHost.js'),
      ]);
      report.importMs = Math.round(performance.now() - began);
      const store = assetMod.assets;
      store.seed(data.getRaw('assets')); store.seedLocal(data.getRaw('local'));
      report.step = '创建正式构建的战场'; show();
      const creating = performance.now();
      const raw = await mod.createFieldView(field, { data, assets: store, settings: settingsStore.get(),
        padding: hostMod.hudPadding, hud: hostMod.hudBands, signal: controller.signal });
      report.factoryMs = Math.round(performance.now() - creating);
      report.exceedsGameTimeout = report.factoryMs >= 12000;
      view = { kind: 'engine', raw, setStage: (...args) => raw.setStage(...args), setPrep: (...args) => raw.setPrep(...args) };
    } finally { clearTimeout(deadline); }
  } else {
    const { mountFieldView } = await import('../js/ui/fieldHost.js');
    view = await mountFieldView(field);
  }
  liveView = view;
  report.renderer = view.kind;
  report.pixi = globalThis.PIXI?.VERSION || null;
  report.spine = !!globalThis.PIXI?.spine;
  if (view.kind === 'engine') {
    view.setStage(data.list('stages')[0]);
    view.setPrep({ board: [], hand: [], temp: [] }, { editable: false });
  }
  report.step = '检查结束';
} catch (error) {
  report.step = '检查失败'; report.error = `${error.name}: ${error.message}`;
  report.stack = error.stack;
} finally { clearInterval(heartbeat); heartbeat = null; report.elapsedMs = Math.round(performance.now() - started); show(); }
addEventListener('pagehide', () => { clearInterval(heartbeat); liveView?.raw?.destroy?.(); }, { once: true });
