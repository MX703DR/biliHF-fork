import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeSearchEvents, replayInitialVideoSearch } from '../src/initial-search';
function harness(params: any = { keyword: '原神', page: 1, search_type: 'video' }, consume = true) {
  const original = vi.fn().mockResolvedValue({ result: ['原生新请求'] });
  const snapshot = { result: [{ bvid: 'BV1kept' }], numResults: 1000, seid: 'SSR' };
  const store = { searchTypeResponse: snapshot, querySearchByType: original };
  let result: any; let current = true;
  const bus = { all: new Map([['submitSearch', []]]), emit: vi.fn(() => { if (consume) result = store.querySearchByType(params); }) };
  const app = { _container: { _vnode: { component: { provides: { [Symbol('PROVIDE_EVENTS')]: bus } } } } };
  const context = { keyword: '原神', page: 1, isCurrent: () => current, waitMs: 500 };
  return { app, context, state: { searchTypeResponse: store }, store, original, snapshot, bus, result: () => result, change: () => { current = false; } };
}
afterEach(() => vi.useRealTimers());
describe('视频搜索本地列表的原生数据回放', () => {
  it('同查询同页只回放一次已过滤 SSR 响应，不多发请求、不复制 UI，并恢复 action', async () => {
    const h = harness(); expect(nativeSearchEvents(h.app)).toBe(h.bus);
    expect(await replayInitialVideoSearch(h.app, h.state, h.context)).toBe(true);
    expect(await h.result()).toBe(h.snapshot); expect(h.original).not.toHaveBeenCalled(); expect(h.store.querySearchByType).toBe(h.original);
    await h.store.querySearchByType({ keyword: '新查询' }); expect(h.original).toHaveBeenCalledOnce();
  });
  it.each([{ keyword: '别的词', page: 1, search_type: 'video' }, { keyword: '原神', page: 2, search_type: 'video' }, { keyword: '原神', page: 1, search_type: 'bili_user' }])('参数变化不能拿旧 SSR 代替新查询：%j', async params => {
    const h = harness(params); expect(await replayInitialVideoSearch(h.app, h.state, h.context)).toBe(false);
    expect(await h.result()).toEqual({ result: ['原生新请求'] }); expect(h.original).toHaveBeenCalledOnce(); expect(h.store.querySearchByType).toBe(h.original);
  });
  it('原生控制器不存在或规则已变时不安装回放钩子', async () => {
    const h = harness(); h.change(); expect(await replayInitialVideoSearch(h.app, h.state, h.context)).toBe(false); expect(h.bus.emit).not.toHaveBeenCalled();
    expect(nativeSearchEvents({})).toBeNull(); expect(await replayInitialVideoSearch({}, h.state, { ...h.context, isCurrent: () => true })).toBe(false);
  });
  it('等待原生控制器时规则变更，应恢复真实查询，不能回放旧版本结果', async () => {
    const h = harness(undefined, false); const p = replayInitialVideoSearch(h.app, h.state, h.context);
    h.change(); const response = h.store.querySearchByType({ keyword: '原神', page: 1, search_type: 'video' });
    expect(await p).toBe(false); expect(await response).toEqual({ result: ['原生新请求'] }); expect(h.store.querySearchByType).toBe(h.original);
  });
  it('控制器没有消费或抛错，500ms 内恢复 action，不能永久接管后续搜索', async () => {
    vi.useFakeTimers(); const h = harness(undefined, false); const p = replayInitialVideoSearch(h.app, h.state, h.context);
    await vi.advanceTimersByTimeAsync(500); expect(await p).toBe(false); expect(h.store.querySearchByType).toBe(h.original);
    h.bus.emit.mockImplementation(() => { throw new Error('原生入口改版'); });
    expect(await replayInitialVideoSearch(h.app, h.state, h.context)).toBe(false); expect(h.store.querySearchByType).toBe(h.original);
  });
});
