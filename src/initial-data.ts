// B站 SSR 首屏：先判定并暂缓显示，hydrate 后通过真实 Pinia 响应式数组一次提交。
// 不能在 hydrate 前删状态却留下旧 HTML，否则 Vue 会把旧标题/链接接到错误的列表项上。
import { normFeedItem } from './cardinfo';
import { filterVideoList, prepareVideoList, searchVideoSources } from './net';
import type { VideoSource } from './net';
import { FILTER_WAIT_MS, immediateVerdict } from './video-filter';
import { blockedLog, recordBlock } from './stats';
import { CONFIG } from './config';
import { logErr } from './logging';
import { health } from './health';
import { ruleVersion } from './match/engine';
import { replayInitialVideoSearch } from './initial-search';
import { HOME_RECOMMEND_CONTAINER, SEARCH_VIDEO_CONTAINER, VIDEO_CARD_SELECTORS } from './selectors';
import { observeInitialMetadata } from './metadata-cache';

const pendingContainers = new Map<string, number>();
const observedStates = new WeakMap<object, number>();
export const isInitialStatePending = (card?: Element): boolean =>
  [...pendingContainers].some(([selector, count]) => count > 0 && (!card || !!card.closest(selector)));
export const unwrapState = (value: any): any => value?.__v_isRef ? value.value : value;

/** 首页会把 Ref 写回 __pinia，搜索页不会；统一取得挂载后的真实 store，不能 splice 脱钩的快照。 */
export function piniaStateFromApp(app: any): any | null {
  const provides = app?._context?.provides;
  if (!provides) return null;
  for (const key of Reflect.ownKeys(provides)) {
    const stores = provides[key]?._s;
    if (!stores || typeof stores.get !== 'function') continue;
    const state: any = {};
    for (const name of ['feed', 'searchResponse', 'searchTypeResponse']) {
      const store = stores.get(name);
      if (store) state[name] = store;
    }
    if (Object.keys(state).length) return state;
  }
  return null;
}

/** 搜索 store 使用 shallowRef，嵌套 splice 不通知 Vue；重新赋根对象，嵌套数组仍保持身份。 */
export function notifyInitialState(state: any): void {
  for (const [storeName, field] of [['feed', 'data'], ['searchResponse', 'searchAllResponse'], ['searchTypeResponse', 'searchTypeResponse']]) {
    const store = unwrapState(state?.[storeName]);
    const current = store?.[field]; const value = unwrapState(current);
    if (!value || typeof value !== 'object') continue;
    if (current?.__v_isRef) current.value = { ...value }; else store[field] = { ...value };
  }
}

function initialVideoSources(state: any): VideoSource[] {
  if (!state || typeof state !== 'object') return [];
  const feed = unwrapState(unwrapState(state.feed)?.data);
  const candidates = [feed?.recommend?.item, feed?.head?.recommend, state.recommendData?.item, state.related, state.videoRelated, state.rankList, state.videoList];
  const sources: VideoSource[] = candidates.filter(Array.isArray).map((items) => ({ items }));
  sources.push(...searchVideoSources(unwrapState(unwrapState(state.searchResponse)?.searchAllResponse)));
  sources.push(...searchVideoSources(unwrapState(unwrapState(state.searchTypeResponse)?.searchTypeResponse)));
  const seen = new Set<any[]>();
  return sources.filter(({ items }) => !seen.has(items) && !!seen.add(items));
}

export function initialVideoLists(state: any): any[][] {
  return initialVideoSources(state).map(({ items }) => items);
}
const initialCount = (sources: VideoSource[]): number => new Set(sources.flatMap(({ items }) => items.map((it) => it?.bvid || it))).size;

/** 两份首屏列表常包含同一视频（原始 item + 转换后的 head）；只记账一次。 */
export function filterInitialState(state: any): number {
  observeInitialMetadata(state);
  const sources = initialVideoSources(state);
  if (sources.length && !observedStates.has(state)) {
    health.initialParsed++;
    health.initialItems += initialCount(sources);
  }
  const recorded = new Set<string>();
  const record = (reason: string, info: ReturnType<typeof normFeedItem>) => {
    if (!info) return;
    const key = info.bvid || info.uid + ':' + info.title;
    if (recorded.has(key)) return;
    recorded.add(key);
    // HTML 解析器可能先吐出 SSR 卡片；DOM 在绘制前已拦过的首屏项不再重复记账。
    if (info.bvid && blockedLog.some((x) => x.bvid === info.bvid && x.src === 'DOM')) return;
    recordBlock(reason, info, 'NET');
  };
  const removed = sources.reduce((count, { items, norm }) => count + filterVideoList(items, norm, record), 0);
  if (sources.length) {
    const kept = initialCount(sources);
    health.initialKept += kept - (observedStates.get(state) || 0);
    observedStates.set(state, kept);
  }
  return removed;
}

export function installInitialStateHooks(onReady: () => void): void {
  const W: any = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const process = (state: any) => {
    try {
      observeInitialMetadata(state);
      if (!CONFIG.enabled || CONFIG.reviewMode) { filterInitialState(state); return; }
      const sources = initialVideoSources(state);
      const needsGate = sources.some(({ items, norm = normFeedItem }) => items.some((it) => {
        const info = norm(it); if (!info) return false;
        const verdict = immediateVerdict(info);
        return !verdict || !!verdict.reason;
      }));
      if (!needsGate) { filterInitialState(state); return; }
      const started = Date.now();
      const pageKey = location.pathname + location.search;
      const home = location.hostname === 'www.bilibili.com' && location.pathname === '/';
      const container = home ? HOME_RECOMMEND_CONTAINER : location.hostname === 'search.bilibili.com' ? SEARCH_VIDEO_CONTAINER : VIDEO_CARD_SELECTORS.join(',');
      pendingContainers.set(container, (pendingContainers.get(container) || 0) + 1);
      const style = document.createElement('style');
      style.textContent = `${container}{visibility:hidden!important}`;
      (document.head || document.documentElement)?.appendChild(style);
      let finished = false;
      let mountTimer: ReturnType<typeof setTimeout> | undefined;
      const mountedApp = () => (document.querySelector('#app') as any)?.__vue_app__ || (document.querySelector('#i_cecream') as any)?.__vue_app__;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        clearTimeout(mountTimer);
        const app = mountedApp();
        let live: any;
        let removed = 0;
        try {
          if (app) {
            live = piniaStateFromApp(app) || state;
            removed = filterInitialState(live);
            if (removed) notifyInitialState(live);
          }
        } catch (e) { logErr('首屏状态过滤', e); }
        // 先让 Vue 的更新微任务移除命中项，再扫描和揭开临时闸门。页面加载失败时不破坏尚未 hydrate 的快照。
        const release = () => queueMicrotask(() => {
          const count = (pendingContainers.get(container) || 1) - 1;
          if (count) pendingContainers.set(container, count); else pendingContainers.delete(container);
          try { onReady(); } catch (e) { logErr('首屏兜底扫描', e); }
          requestAnimationFrame(() => { try { onReady(); } finally { style.remove(); } });
        });
        const remaining = FILTER_WAIT_MS + 500 - (Date.now() - started);
        if (removed && app && location.hostname === 'search.bilibili.com' && location.pathname === '/video' && remaining > 0) {
          const query = new URLSearchParams(location.search); const version = ruleVersion;
          Promise.resolve().then(() => replayInitialVideoSearch(app, live, {
            keyword: query.get('keyword') || '', page: Number(query.get('page') || 1), waitMs: Math.min(500, remaining),
            isCurrent: () => CONFIG.enabled && !CONFIG.reviewMode && ruleVersion === version && location.pathname + location.search === pageKey,
          })).then(release, release);
        } else release();
      };
      const watchdog = setTimeout(finish, FILTER_WAIT_MS + 500);
      const waitForMount = () => {
        if (finished) return;
        if (mountedApp()) finish(); else mountTimer = setTimeout(waitForMount, 20);
      };
      Promise.all(sources.map(({ items, norm }) => prepareVideoList(items, norm))).then(waitForMount, waitForMount);
    } catch (e) {
      logErr('首屏状态钩子', e);
    }
  };
  for (const key of ['__pinia', '__INITIAL_STATE__']) {
    const descriptor = Object.getOwnPropertyDescriptor(W, key);
    if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) continue;
    let value = descriptor?.value;
    try {
      Object.defineProperty(W, key, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: () => value,
        set: (next) => { value = next; process(next); },
      });
      if (value) process(value);
    } catch (e) {
      logErr('installInitialStateHooks', e);
    }
  }
}
