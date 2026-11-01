// 当前在线人数 pill hook (GET /api/online, 合并自用户分支): shared by the screens that show the pill — the lobby
// hub's top bar, beside its ping capsule (screens/lobby.js .topbar-online). The server answers from its own ~10 s
// cache (server/http/routes.js), so this side polls once every 10 s — never more often —, skips a tick while the
// page is hidden, keeps the last count between ticks, and reports null (the pill hides) when the request fails —
// a server that is gone, or local standalone play without one. [ASSUMED: no push channel for the count, a slow
// poll is enough.]
import { useEffect, useState } from '../../vendor/hooks.module.js';

const ONLINE_POLL_MS = 10_000;

/** The server's online count for the online pill, or null while it is unknown (hidden). */
export function useOnlineCount() {
  const [online, setOnline] = useState(null);
  useEffect(() => {
    let live = true;
    let controller = null;
    const tick = async () => {
      if (document.hidden) return; // the tab is in the background: skip this round, the value is cached anyway
      controller?.abort();
      const mine = controller = new AbortController();
      const stop = setTimeout(() => mine.abort(), 5000);
      try {
        const res = await fetch('/api/online', { cache: 'no-store', signal: mine.signal });
        const n = res.ok ? Number((await res.json())?.online) : NaN;
        if (live) setOnline(Number.isFinite(n) && n >= 0 ? n : null);
      } catch {
        if (live) setOnline(null); // no server (local standalone) or a failed request: hide gracefully
      } finally {
        clearTimeout(stop);
        if (controller === mine) controller = null;
      }
    };
    void tick();
    const timer = setInterval(tick, ONLINE_POLL_MS);
    return () => { live = false; clearInterval(timer); controller?.abort(); };
  }, []);
  return online;
}
