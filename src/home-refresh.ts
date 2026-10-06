// 只替换首页“换一换”的动作，不改版式。
// 现行 B站 RollButton 只 getHead(Change)；FlexibleRollBtn 的原生 Refresh 会重置下方流、游标并加载新批次。
// 优先复用该入口（签名、访客参数、地区和 AB 版本仍由 B站管理），旧版找不到入口才整页刷新。
import { CONFIG } from './config';
import { unwrapState } from './initial-data';
import { logErr } from './logging';
import { advanceHomeFeedEpoch } from './net';
import { HOME_ROLL_BUTTON, HOME_FULL_REFRESH } from './selectors';

export interface HomeRefreshDeps {
  enabled: () => boolean;
  isHome: () => boolean;
  fullRefresh: () => HTMLElement | null;
  loading: () => boolean;
  reload: () => void;
  now: () => number;
  later: (cb: () => void, ms: number) => void;
  onFullRefresh?: () => void;
  withoutScroll?: (action: () => void) => void;
  guardNativeScroll?: () => () => void;
}

/** 原生 Refresh 的按钮与推荐组件各回顶一次。只在这次同步分发中屏蔽滚动，立刻恢复原方法。 */
export function beginHomeRefreshScrollGuard(host: Pick<Window, 'scroll' | 'scrollTo' | 'scrollBy'>): () => void {
  const patches: Array<{ name: 'scroll' | 'scrollTo' | 'scrollBy'; descriptor?: PropertyDescriptor; noop: () => void }> = [];
  const restore = () => {
    for (const { name, descriptor, noop } of patches.reverse()) {
      // 同步回调若有其他扩展更新该方法，不把它的新实现覆盖掉。
      if (host[name] !== noop) continue;
      if (descriptor) Object.defineProperty(host, name, descriptor);
      else Reflect.deleteProperty(host, name);
    }
    patches.length = 0;
  };
  try {
    for (const name of ['scroll', 'scrollTo', 'scrollBy'] as const) {
      if (typeof host[name] !== 'function') continue;
      const descriptor = Object.getOwnPropertyDescriptor(host, name);
      if (descriptor && !descriptor.configurable && !descriptor.writable) continue;
      const noop = () => {};
      Object.defineProperty(host, name, { value: noop, writable: true, enumerable: descriptor?.enumerable ?? true, configurable: descriptor?.configurable ?? true });
      patches.push({ name, descriptor, noop });
    }
    return restore;
  } catch (e) { restore(); throw e; }
}

export function withoutHomeRefreshScroll(host: Pick<Window, 'scroll' | 'scrollTo' | 'scrollBy'>, action: () => void): void {
  const restore = beginHomeRefreshScrollGuard(host);
  try { action(); } finally { restore(); }
}
export function createHomeRefreshHandler(deps: HomeRefreshDeps): (event: MouseEvent) => void {
  let busy = false;
  let dispatching = false;
  return (event) => {
    if (dispatching) return; // 放行下面转发的原生 click，不能再递归转发或推进批次。
    if (!deps.enabled() || !deps.isHome() || event.button !== 0) return;
    const target = event.target as Element | null;
    const nativeButton = target?.closest<HTMLElement>(HOME_FULL_REFRESH);
    const button = target?.closest<HTMLButtonElement>(HOME_ROLL_BUTTON);
    if (!button && !nativeButton) return;
    if (busy || deps.loading()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    // 原生入口保留这一次真实分发，不能对同一元素嵌套 click（HTML 的 click-in-progress 会吞掉它）。
    if (!nativeButton) { event.preventDefault(); event.stopImmediatePropagation(); }
    const refresh = nativeButton || deps.fullRefresh();
    if (!refresh) { deps.reload(); return; }
    busy = true;
    const disabled = button?.disabled;
    if (button) button.disabled = true;
    const started = deps.now();
    const finish = () => { busy = false; if (button) button.disabled = disabled!; };
    const check = () => {
      const elapsed = deps.now() - started;
      if (elapsed >= 20000 || (elapsed >= 600 && !deps.loading())) finish();
      else deps.later(check, 100);
    };
    try {
      deps.onFullRefresh?.();
      if (nativeButton) {
        const restore = deps.guardNativeScroll?.();
        // 用下一任务而非微任务：真实鼠标事件在 capture/bubble 回调之间可能先刷新微任务队列。
        if (restore) deps.later(restore, 0);
        deps.later(check, 100);
        return;
      }
      const click = () => {
        dispatching = true;
        try { refresh.click(); } finally { dispatching = false; }
      };
      if (deps.withoutScroll) deps.withoutScroll(click);
      else click();
      deps.later(check, 100);
    } catch (e) {
      finish();
      logErr('首页完整刷新', e);
      deps.reload();
    }
  };
}

export function installHomeRefresh(): void {
  const W: any = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  document.addEventListener('click', createHomeRefreshHandler({
    enabled: () => CONFIG.enabled,
    isHome: () => location.hostname === 'www.bilibili.com' && location.pathname === '/',
    fullRefresh: () => document.querySelector<HTMLElement>(HOME_FULL_REFRESH),
    loading: () => !!unwrapState(unwrapState(W.__pinia?.feed)?.data)?.loading,
    reload: () => location.reload(),
    now: () => Date.now(),
    later: (cb, ms) => setTimeout(cb, ms),
    onFullRefresh: advanceHomeFeedEpoch,
    withoutScroll: (action) => withoutHomeRefreshScroll(W, action),
    guardNativeScroll: () => beginHomeRefreshScrollGuard(W),
  }), true);
}
