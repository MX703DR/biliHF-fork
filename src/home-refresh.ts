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
}

export function createHomeRefreshHandler(deps: HomeRefreshDeps): (event: MouseEvent) => void {
  let busy = false;
  return (event) => {
    if (!deps.enabled() || !deps.isHome() || event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest(HOME_FULL_REFRESH)) {
      if (!busy && !deps.loading()) deps.onFullRefresh?.();
      return;
    }
    const button = target?.closest<HTMLButtonElement>(HOME_ROLL_BUTTON);
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy || deps.loading()) return;
    const refresh = deps.fullRefresh();
    if (!refresh) { deps.reload(); return; }
    busy = true;
    const disabled = button.disabled;
    button.disabled = true;
    const started = deps.now();
    const finish = () => { busy = false; button.disabled = disabled; };
    const check = () => {
      const elapsed = deps.now() - started;
      if (elapsed >= 20000 || (elapsed >= 600 && !deps.loading())) finish();
      else deps.later(check, 100);
    };
    try {
      deps.onFullRefresh?.();
      refresh.click();
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
  }), true);
}
