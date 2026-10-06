// 完整换新只调用原站 WEB getHead(Change)，保留登录凭据、签名与推荐会话，不触发会滚动的 Refresh 事件。
import { CONFIG } from './config';
import { piniaStateFromApp, unwrapState } from './initial-data';
import { logErr } from './logging';
import { advanceHomeFeedEpoch } from './net';
import { canResetHomeFeedView, resetHomeFeedView } from './home-grid';
import { HOME_ROLL_BUTTON, HOME_FULL_REFRESH } from './selectors';
import { toast } from './ui/toast';

export const WEB_CHANGE = 3;
export const WEB_LOAD_MORE = 4;
const pagingGuards = new WeakSet<object>();
const replacingFeeds = new WeakSet<object>();

/** 游客登录提示不是推荐内容；不能因仅剩提示卡而触发原站自动补满循环。 */
export function hasNativeHomeContent(feed: any): boolean {
  const head = unwrapState(feed?.data)?.head?.recommend;
  return Array.isArray(head) && head.some(item => item && (item.goto || item.card_goto) !== 'login_card');
}

/** 设置/菜单内部滚动不是浏览推荐，不能顺带触发首页补拉。 */
export function isHomeBrowsingInput(event: Event): boolean {
  return !event.defaultPrevented && !(event.target as Element | null)?.closest?.('[id^="bfb-"], .bfb-modal-back');
}

/** 原站分页闭包会在卸载后继续延迟补拉；在参数推进前取消，避免发出无效请求。 */
export function guardNativeWebPaging(feed: any, suspended: () => boolean): void {
  if (!feed || pagingGuards.has(feed) || typeof feed.updateParams !== 'function') return;
  const original = feed.updateParams;
  feed.updateParams = function (this: unknown, type: number, ...args: any[]) {
    if (type === WEB_LOAD_MORE && suspended()) throw new DOMException('Homepage native paging is suspended', 'AbortError');
    return original.apply(this, [type, ...args]);
  };
  pagingGuards.add(feed);
}
export interface HomeRefreshDeps {
  enabled: () => boolean;
  isHome: () => boolean;
  loading: () => boolean;
  refresh: () => Promise<boolean>;
  reload: () => void;
  failed?: (error: unknown) => void;
}

export function createHomeRefreshHandler(deps: HomeRefreshDeps): (event: MouseEvent) => void {
  let busy = false;
  return event => {
    if (!deps.enabled() || !deps.isHome() || event.button !== 0) return;
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>(HOME_ROLL_BUTTON);
    if (!button && !target?.closest(HOME_FULL_REFRESH)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (busy || deps.loading()) return;
    busy = true; const disabled = button?.disabled; if (button) button.disabled = true;
    Promise.resolve().then(deps.refresh).then(handled => { if (!handled) deps.reload(); }, error => deps.failed?.(error)).finally(() => {
      busy = false; if (button) button.disabled = disabled!;
    });
  };
}

/** 关闭本次替换造成的浏览器滚动锚定，不在滚动之后再强拉回去。 */
export function beginHomeRefreshLayoutGuard(doc: Document): () => void {
  const patches: Array<{ style: CSSStyleDeclaration; name: string; value: string; priority: string; own: string }> = [];
  const patch = (style: CSSStyleDeclaration, name: string, own: string) => {
    patches.push({ style, name, value: style.getPropertyValue(name), priority: style.getPropertyPriority(name), own });
    style.setProperty(name, own, 'important');
  };
  for (const el of [doc.documentElement, doc.body]) if (el) {
    patch(el.style, 'overflow-anchor', 'none');
  }
  // ClientOnly 的新插槽可能下一帧才挂载；不能让这中间一帧的高度收缩夹掉 scrollY。
  const view = doc.defaultView;
  if (doc.body && view) patch(doc.body.style, 'min-height', `${Math.ceil(view.scrollY + view.innerHeight)}px`);
  let restored = false;
  return () => {
    if (restored) return; restored = true;
    for (const p of patches) if (p.style.getPropertyValue(p.name) === p.own && p.style.getPropertyPriority(p.name) === 'important') {
      if (p.value) p.style.setProperty(p.name, p.value, p.priority); else p.style.removeProperty(p.name);
    }
  };
}

export interface NativeWebFeedDeps { reset: () => Promise<void>; advance: () => void; afterPaint: () => Promise<void> }
/** 原站方法自己追加曝光/点击/uniq_id 并完成 WBI 签名；不手写请求、不剥离 Cookie。 */
export async function replaceNativeWebFeed(feed: any, deps: NativeWebFeedDeps, loadMore = false): Promise<void> {
  const previous = unwrapState(feed.data).recommend;
  const type = loadMore ? WEB_LOAD_MORE : WEB_CHANGE;
  if (!loadMore) deps.advance();
  await feed.getHead({ ...feed.getPsParams(type), fresh_type: type, fetch_row: loadMore ? Number(feed.fetch_row) + 3 : 1 });
  if (unwrapState(feed.data).recommend === previous) throw new Error('网页版推荐刷新失败，已保留原列表；未切换匿名或 App 推荐');
  if (!loadMore) feed.fetch_row = 1;
  feed.noMoreFeed = false;
  // 整批被过滤时不能让新组件自动再请求 Init，也不为补满卡片循环请求。
  const init = feed.initRequest;
  const guardedInit = function (this: unknown, ...args: any[]) {
    return hasNativeHomeContent(feed) ? init.apply(this, args) : Promise.resolve();
  };
  feed.initRequest = guardedInit;
  try { await deps.reset(); } finally { if (feed.initRequest === guardedInit) feed.initRequest = init; }
  await deps.afterPaint();
}

function nativeFeed(): any {
  for (const root of document.querySelectorAll('#app, #i_cecream')) {
    const feed = piniaStateFromApp((root as any).__vue_app__)?.feed;
    if (typeof feed?.getHead === 'function' && typeof feed?.getPsParams === 'function') {
      guardNativeWebPaging(feed, () => CONFIG.enabled && (replacingFeeds.has(feed) || (!CONFIG.reviewMode && !hasNativeHomeContent(feed))));
      return feed;
    }
  }
  return null;
}

export function installHomeRefresh(): void {
  const W: any = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const isHome = () => location.hostname === 'www.bilibili.com' && location.pathname === '/';
  let running = false;
  const refresh = async (loadMore = false) => {
    const feed = nativeFeed();
    if (!feed || !canResetHomeFeedView()) return false;
    if (running) return true;
    running = true; replacingFeeds.add(feed); const restore = beginHomeRefreshLayoutGuard(document);
    try {
      await replaceNativeWebFeed(feed, { reset: resetHomeFeedView, advance: advanceHomeFeedEpoch,
        afterPaint: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) }, loadMore);
      replacingFeeds.delete(feed); // 原生新哨兵的检查允许正常分页；旧空批次仍被本地保护挡住。
      // 只重新检查原站哨兵，不移动页面；避免用户滚动恰好发生在请求等待期而错过加载检查。
      if (W.scrollY > 0) W.dispatchEvent(new W.Event('scroll'));
      return true;
    } finally { restore(); replacingFeeds.delete(feed); running = false; }
  };
  const failed = (error: unknown) => { logErr('首页 WEB 完整换新', error); toast(error instanceof Error ? error.message : '网页版推荐刷新失败，已保留原列表', 'error'); };
  document.addEventListener('click', createHomeRefreshHandler({ enabled: () => CONFIG.enabled, isHome,
    loading: () => running || !!unwrapState(nativeFeed()?.data)?.loading,
    refresh, reload: () => location.reload(), failed }), true);

  // 头部整批被过滤时原站不渲染哨兵。仅用户明确向下浏览时取下一批 WEB 推荐，不自动补拉。
  const recoverEmpty = () => {
    if (!CONFIG.enabled || !isHome() || running || CONFIG.reviewMode) return;
    const feed = nativeFeed(); const data = unwrapState(feed?.data);
    if (!feed || data?.loading || feed.noMoreFeed || !Array.isArray(data?.head?.recommend) || hasNativeHomeContent(feed)) return;
    if (W.scrollY + W.innerHeight + 200 < document.body.scrollHeight) return;
    void refresh(true).catch(failed);
  };
  W.addEventListener('wheel', (event: WheelEvent) => { if (isHomeBrowsingInput(event) && event.deltaY > 0) recoverEmpty(); }, { passive: true });
  W.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!isHomeBrowsingInput(event) || (event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable],a,button,[role="button"]')) return;
    if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) recoverEmpty();
  });
  let touchY = 0;
  W.addEventListener('touchstart', (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; }, { passive: true });
  W.addEventListener('touchmove', (event: TouchEvent) => {
    const y = event.touches[0]?.clientY ?? touchY; if (isHomeBrowsingInput(event) && y < touchY) recoverEmpty(); touchY = y;
  }, { passive: true });
}
