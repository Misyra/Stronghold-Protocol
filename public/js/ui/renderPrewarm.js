// ui/renderPrewarm.js — 对局渲染引擎的空闲预热。渲染引擎（render/app.js，构建形态下是 674 kB 的 app
// chunk，静态带上 host chunk）只在挂载对局视图时被动态 import（ui/fieldHost.js mountFieldView），首次
// 进对局要串行等它的传输与编译。这里在首次路由渲染稳定后的空闲时间把同一模块拉下来，进对局时命中的
// 就是已编译好的模块。
//
// 这里的 import 表达式与 fieldHost.js 的一字不差（同一个说明符），两种交付形态下都落在同一模块实例上：
//  - 构建（vite）：两处都被改写到同一个 /build/assets/app-*.js chunk（host-*.js 是它的静态依赖，一起
//    到位；/shared /sim /data 保持原生 URL，不在此列——见 vite.config.js 头注释）；
//  - 源码（未构建）：两处都解析到 /js/render/app.js 这个原生 URL，预热只是提前求值一次，之后挂载时的
//    import 命中浏览器模块缓存，是无害空转。
// 每个页面生命周期只预热一次：重复 arm()（重复 boot、pageshow 返回）是空操作；页面隐藏/卸载不会重新
// 触发，requestIdleCallback 与兜底定时器在隐藏页里本来就不会按时跑。
const IMPORT_ENGINE = () => import('../render/app.js');
// requestIdleCallback 天然让路给页面正在做的事（开场影片、标题页的动画、资源预载的高峰）；但没有期限的
// rIC 在持续动画的页面上可能被一直推迟（构建页 headless 实测出现过 9 s 不触发），给一个 3 s 的期限：回调
// 仍只在帧间隙里跑，最迟此时兜底。没有 rIC 的浏览器用 1–2 s 的定时器兜底。
const IDLE_TIMEOUT_MS = 3000;
const IDLE_FALLBACK_MS = 1500;
const defaultSchedule = (fire) => (
  typeof requestIdleCallback === 'function'
    ? requestIdleCallback(fire, { timeout: IDLE_TIMEOUT_MS })
    : setTimeout(fire, IDLE_FALLBACK_MS)
);

/**
 * 创建一次性的空闲预热。`import` 与 `schedule` 仅供测试注入；页面用的是下面的模块单例。
 * @param {{ import?: () => Promise<unknown>, schedule?: (fire: () => void) => unknown }} [deps]
 */
export function createRenderPrewarm({ import: importEngine = IMPORT_ENGINE, schedule = defaultSchedule } = {}) {
  let armed = false;
  return {
    /** 预热一次：只调度一个空闲回调；失败只记日志，从不抛出。 */
    arm() {
      if (armed) return;
      armed = true;
      schedule(() => {
        importEngine().catch((err) => console.warn('[app] render prewarm failed', err));
      });
    },
  };
}

/** 页面的预热单例（main.js boot 里 arm 一次）。 */
export const renderPrewarm = createRenderPrewarm();
