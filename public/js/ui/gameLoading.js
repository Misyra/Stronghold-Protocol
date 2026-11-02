// The in-match loader (ported from the Stardust fork's ui/gameLoading.js): a spinner alone told the player nothing when
// one data file failed — the match screen waited forever. This lists every file the match UI needs that is not ready
// yet, can retry exactly those, and offers a reload; after 8 s, or with a failed file, it also explains what is going
// on. A resumed session still waiting for its match says 「正在恢复对局」 (a server restart rebuilds the match from its
// checkpoint, docs/DEPLOY.md §11 — a reload does not speed it up).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Spinner, useTicker } from './components.js';
import { GAME_FILES } from './gameComponents.js';
import { data, DATA_FILES } from '../data.js';
import { useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';

/** Art is optional: a match runs without the extracted models and pictures (the screens draw their own fallbacks). */
const OPTIONAL = new Set(['assets', 'local']);

/** @param {any} [source] the data store (tests pass a stand-in) @returns {boolean} a file every match needs never arrived */
export const missingCoreData = (source = data) => GAME_FILES.some((name) => !OPTIONAL.has(name) && source.status(name) === 'missing');

/**
 * The files the match UI is still waiting for; a failed optional file is not one of them.
 * @param {any} [source] @returns {Array<{ name: string, status: string }>}
 */
export const pendingGameFiles = (source = data) => GAME_FILES
  .map((name) => ({ name, status: source.status(name) }))
  .filter(({ name, status }) => status !== 'ready' && !(OPTIONAL.has(name) && status === 'missing'));

const fileName = (name) => DATA_FILES[name] || `${name}.json`;

/**
 * @param {{ hasPublic: boolean, slow?: boolean, files?: Array<{ name: string, status: string }>, retrying?: boolean,
 *   resumed?: boolean, note?: string|null, onRetry?: () => void, onReload?: () => void }} props
 */
export function GameLoadingView({ hasPublic, slow = false, files = [], retrying = false, resumed = false, note = null, onRetry, onReload }) {
  const failed = files.some((f) => f.status === 'missing');
  const restoring = resumed && !hasPublic && !failed;
  return html`<div class="screen gload">
    <${Spinner} size="lg" label=${failed ? 'DATA UNAVAILABLE' : hasPublic ? 'LOADING DATA' : restoring ? 'RESTORING MATCH' : 'ENTERING SIMULATION'} />
    <p class="t-lo" role="status">${note ? note
      : failed ? t('部分模拟数据未能载入') : hasPublic ? t('正在载入模拟数据…') : restoring ? t('正在恢复对局…') : t('正在进入模拟…')}</p>
    ${slow || failed ? html`<section class="gload__recovery" aria-label=${t('载入恢复')}>
      <${MicroLabel}>CONNECTION RECOVERY<//>
      <p>${files.length ? t('以下文件仍未就绪，可以重试或刷新页面。')
        : restoring ? t('服务器重启后正在恢复对局，最长约需两分钟。') : t('正在等待服务器同步对局，可以刷新页面重新连接。')}</p>
      ${files.length ? html`<ul>${files.map(({ name, status }) => html`<li key=${name}>
        <span>${fileName(name)}</span><span>${status === 'missing' ? t('载入失败') : t('等待载入')}</span>
      </li>`)}</ul>` : null}
      <div class="gload__actions">
        ${files.length && onRetry ? html`<${Button} variant="primary" disabled=${retrying} loading=${retrying} onClick=${onRetry}>${t('重试未完成项')}<//>` : null}
        ${onReload ? html`<${Button} variant="secondary" onClick=${onReload}>${t('刷新页面')}<//>` : null}
      </div>
      ${files.length ? html`<small>${t('重试只重新下载未就绪的数据，不会退出房间。')}</small>` : null}
    </section>` : null}
  </div>`;
}

/**
 * The loading screen the game route shows while the match data is incomplete. `note` replaces the status line (the
 * screen passes its version-check message).
 * @param {{ hasPublic: boolean, note?: string|null }} props
 */
export function GameLoading({ hasPublic, note = null }) {
  useTicker(1000);
  // the page resumed a server session (main.js ui.restoring): its room and match are on their way
  const resumed = useStore((s) => !!s.ui?.restoring);
  const [since] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const files = pendingGameFiles();
  const retry = async () => {
    if (busy.current) return;
    busy.current = true;
    setRetrying(true);
    try {
      await Promise.all(files.map(({ name, status }) => (status === 'idle' ? data.load(name) : data.invalidate(name))));
    } finally {
      busy.current = false;
      if (mounted.current) setRetrying(false);
    }
  };
  return html`<${GameLoadingView} hasPublic=${hasPublic} slow=${Date.now() - since >= 8000} resumed=${resumed}
    files=${files} retrying=${retrying} note=${note} onRetry=${retry} onReload=${() => globalThis.location?.reload()} />`;
}
