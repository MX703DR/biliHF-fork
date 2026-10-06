import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeRefreshHandler } from '../src/home-refresh';
function harness() {
  const button = { disabled: false };
  let enabled = true, home = true, loading = false, now = 0;
  let refresh: any = { click: vi.fn() };
  const reload = vi.fn(); const timers: (() => void)[] = [];
  const event = { button: 0, target: { closest: (selector: string) => selector === '.roll-btn' ? button : null }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
  const handler = createHomeRefreshHandler({ enabled: () => enabled, isHome: () => home, fullRefresh: () => refresh, loading: () => loading, reload, now: () => now, later: (f) => timers.push(f) });
  return { button, event, reload, handler, click: () => handler(event as any), refresh: () => refresh, disable: () => { enabled = false; }, elsewhere: () => { home = false; }, loading: (v: boolean) => { loading = v; }, noRefresh: () => { refresh = null; }, advance: (ms: number) => { now += ms; timers.splice(0).forEach((f) => f()); } };
}
describe('首页换一换：复用原生完整刷新', () => {
  it('拦住两行刷新，只点击一次原生“刷新内容”，保留按钮和布局', () => {
    const h = harness(); h.click(); expect(h.refresh().click).toHaveBeenCalledOnce(); expect(h.event.stopImmediatePropagation).toHaveBeenCalledOnce(); expect(h.button.disabled).toBe(true);
    h.click(); expect(h.refresh().click).toHaveBeenCalledOnce(); h.advance(700); expect(h.button.disabled).toBe(false);
  });
  it('在加载中不会重复提交刷新', () => { const h = harness(); h.loading(true); h.click(); expect(h.refresh().click).not.toHaveBeenCalled(); });
  it('不是首页或插件暂停时不干涉站点事件', () => {
    for (const mode of ['disable', 'elsewhere'] as const) { const h = harness(); h[mode](); h.click(); expect(h.event.preventDefault).not.toHaveBeenCalled(); }
  });
  it('找不到原生完整刷新入口，安全降级为整页刷新而不是只改 DOM', () => { const h = harness(); h.noRefresh(); h.click(); expect(h.reload).toHaveBeenCalledOnce(); });
  it('异常和超长加载不会把按钮永久锁死', () => {
    const h = harness(); h.click(); h.loading(true); h.advance(20000); expect(h.button.disabled).toBe(false);
  });
});

import { CONFIG, DEFAULT_CONFIG } from '../src/config';
import { rebuildRules } from '../src/match/engine';
import { filterInitialState, initialVideoLists, unwrapState } from '../src/initial-data';
import { normFeedItem } from '../src/cardinfo';
import { blockedLog } from '../src/stats';
import { health } from '../src/health';
beforeEach(() => { Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG)); rebuildRules(); });
describe('SSR 首屏数据', () => {
  it('支持原始和转换后两份 Pinia 列表，UID/点赞数不因转换而丢失', () => {
    const raw = { bvid: 'BV1initial', title: '视频', owner: { mid: 9, name: 'UP' }, stat: { like: 4 } };
    const head = { bvid: raw.bvid, title: raw.title, author: raw.owner, stats: raw.stat, isAd: false };
    expect(normFeedItem(head)).toMatchObject({ uid: '9', up: 'UP', likes: 4, isAd: false });
    CONFIG.block.uids.push('9'); rebuildRules(); const before = blockedLog.length;
    const state = { feed: { data: { recommend: { item: [raw] }, head: { recommend: [head] } } }, carousel: { item: [raw] }, videoData: raw };
    expect(filterInitialState(state)).toBe(2); expect(blockedLog.length - before).toBe(1);
    expect(state.feed.data.head.recommend).toHaveLength(0); expect(state.carousel.item).toHaveLength(1); expect(state.videoData).toBe(raw);
  });
  it('hydrate 后通过 ref.value 取得响应式数组，而非操作脱钩的旧副本', () => {
    const list = [{ title: '屏蔽词', bvid: 'BV1ref' }];
    const ref = { __v_isRef: true, value: { recommend: { item: list }, head: { recommend: list } } };
    const state = { feed: { data: ref } };
    expect(unwrapState(ref)).toBe(ref.value); expect(initialVideoLists(state)).toEqual([list]);
    CONFIG.block.keywords.push('屏蔽词'); rebuildRules(); expect(filterInitialState(state)).toBe(1); expect(list).toHaveLength(0);
  });
  it('搜索/视频页只处理显式的列表字段，不递归破坏播放数据', () => {
    CONFIG.block.bvids.push('BV1current'); rebuildRules();
    const state = { videoData: { bvid: 'BV1current', title: '当前视频' }, related: [{ bvid: 'BV1current', title: '推荐' }] };
    expect(filterInitialState(state)).toBe(1); expect(state.videoData.bvid).toBe('BV1current');
  });
  it('审查模式和停用时不删除首屏列表', () => {
    CONFIG.reviewMode = true; CONFIG.block.keywords.push('屏蔽词'); rebuildRules();
    const state = { videoList: [{ title: '屏蔽词' }] }; expect(filterInitialState(state)).toBe(0); expect(state.videoList).toHaveLength(1);
  });
  it('首屏自检计数合并所有已知列表，同 BV 的 raw/head 副本不重复计数', () => {
    const raw = [{ bvid: 'BV1first', title: '一' }, { bvid: 'BV1second', title: '二' }];
    const state = { feed: { data: { recommend: { item: raw }, head: { recommend: structuredClone(raw) } } }, videoList: [{ bvid: 'BV1third', title: '三' }] };
    const before = { items: health.initialItems, kept: health.initialKept };
    expect(filterInitialState(state)).toBe(0);
    expect(health.initialItems - before.items).toBe(3); expect(health.initialKept - before.kept).toBe(3);
  });
  it('综合搜索的 Pinia 分组与用户投稿预览都在 hydrate 前过滤，保留用户及分页', () => {
    CONFIG.block.keywords.push('屏蔽词'); rebuildRules();
    const user = { mid: 9, uname: 'UP', res: [{ bvid: 'BV1preview', title: '屏蔽词' }, { bvid: 'BV1keep', title: '保留' }] };
    const data = { page: 2, numResults: 100, result: [
      { result_type: 'bili_user', data: [user] },
      { result_type: 'video', data: [{ bvid: 'BV1search', title: '<em>屏蔽词</em>' }] },
      { result_type: 'media_bangumi', data: [{ title: '屏蔽词' }] },
    ] };
    const state = { searchResponse: { searchAllResponse: { __v_isRef: true, value: data } } };
    expect(filterInitialState(state)).toBe(2);
    expect(user.res.map((x) => x.bvid)).toEqual(['BV1keep']);
    expect(data.result[0].data[0]).toBe(user); expect(data.result[1].data).toHaveLength(0);
    expect(data.result[2].data).toHaveLength(1); expect(data.page).toBe(2); expect(data.numResults).toBe(100);
  });
  it('搜索投稿预览从用户卡片继承 UID，白名单不会因为预览缺 owner 而失效', () => {
    CONFIG.block.keywords.push('屏蔽词'); CONFIG.allow.uids.push('9'); rebuildRules();
    const previews = [{ bvid: 'BV1allowed', title: '屏蔽词' }];
    const state = { searchResponse: { searchAllResponse: { result: [{ result_type: 'bili_user', data: [{ mid: 9, uname: 'UP', res: previews }] }] } } };
    expect(filterInitialState(state)).toBe(0); expect(previews).toHaveLength(1);
    expect(previews[0]).not.toHaveProperty('owner');
  });
  it('视频搜索的 Pinia 单独列表可过滤，而用户搜索结果本身不当成视频删除', () => {
    CONFIG.block.uids.push('9'); CONFIG.block.keywords.push('屏蔽词'); rebuildRules();
    const state = { searchTypeResponse: { searchTypeResponse: { result: [{ type: 'video', bvid: 'BV1type', title: '屏蔽词' }] } } };
    expect(filterInitialState(state)).toBe(1);
    const users = { searchTypeResponse: { searchTypeResponse: { result: [{ type: 'bili_user', mid: 9, uname: 'UP' }] } } };
    expect(filterInitialState(users)).toBe(0); expect(users.searchTypeResponse.searchTypeResponse.result).toHaveLength(1);
  });
});
