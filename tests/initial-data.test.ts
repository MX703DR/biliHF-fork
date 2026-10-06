import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, DEFAULT_CONFIG } from '../src/config';
import { rebuildRules } from '../src/match/engine';
import { installInitialStateHooks, isInitialStatePending, notifyInitialState, piniaStateFromApp } from '../src/initial-data';
let app: any;
let W: any;
let style: any;
const state = () => ({ searchResponse: { searchAllResponse: { result: [{ result_type: 'video', data: [{ bvid: 'BV1bad', title: '屏蔽词' }, { bvid: 'BV1good', title: '保留' }] }] } } });
const list = (s: ReturnType<typeof state>) => s.searchResponse.searchAllResponse.result[0].data;
const makeApp = (s: ReturnType<typeof state>) => ({ _context: { provides: { [Symbol('pinia')]: { _s: new Map([['searchResponse', s.searchResponse]]) } } } });
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG)); CONFIG.block.keywords.push('屏蔽词'); rebuildRules();
  app = null; W = {}; style = { remove: vi.fn(), textContent: '' };
  vi.stubGlobal('unsafeWindow', W);
  vi.stubGlobal('document', { createElement: () => style, head: { appendChild: vi.fn() }, querySelector: (s: string) => s === '#app' ? { __vue_app__: app } : null });
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { f(); return 1; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('SSR 接管时序', () => {
  it('hydrate 前保留与 HTML 一致的完整快照，挂载后只修改真实响应式 store', async () => {
    const original = state(); const live = state(); const ready = vi.fn();
    installInitialStateHooks(ready); W.__pinia = original;
    expect(list(original)).toHaveLength(2); expect(isInitialStatePending()).toBe(true);
    await vi.advanceTimersByTimeAsync(40); expect(list(original)).toHaveLength(2); expect(ready).not.toHaveBeenCalled();
    app = makeApp(live); await vi.advanceTimersByTimeAsync(40);
    expect(list(original)).toHaveLength(2); expect(list(live).map(x => x.bvid)).toEqual(['BV1good']);
    expect(isInitialStatePending()).toBe(false); expect(style.remove).toHaveBeenCalledOnce(); expect(ready).toHaveBeenCalled();
  });
  it('挂载失败有有界降级：恢复可见性，但不破坏未来可能使用的 SSR 快照', async () => {
    const original = state(); installInitialStateHooks(vi.fn()); W.__pinia = original;
    await vi.advanceTimersByTimeAsync(8500);
    expect(list(original)).toHaveLength(2); expect(isInitialStatePending()).toBe(false); expect(style.remove).toHaveBeenCalledOnce();
  });
  it('只取已知 Pinia store，不能修改其它注入项/播放器/轮播', () => {
    const s = state(); const a = makeApp(s);
    a._context.provides[Symbol('other')] = { videoData: { bvid: 'BV1bad' } } as any;
    expect(piniaStateFromApp(a)).toEqual({ searchResponse: s.searchResponse });
    expect(piniaStateFromApp({})).toBeNull();
  });
  it('shallowRef 用新根引用通知渲染，但嵌套数组/分页对象不克隆、不丢失', () => {
    const s = state(); const before = s.searchResponse.searchAllResponse; const items = list(s);
    notifyInitialState(s);
    expect(s.searchResponse.searchAllResponse).not.toBe(before); expect(list(s)).toBe(items);
    const value = { recommend: { item: items }, loading: false };
    const ref = { __v_isRef: true, value }; const home = { feed: { data: ref } };
    notifyInitialState(home); expect(home.feed.data).toBe(ref); expect(ref.value).not.toBe(value); expect(ref.value.recommend.item).toBe(items);
  });
});
