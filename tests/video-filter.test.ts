import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ calls: [] as string[], tags: null as string[] | null, view: null as any, card: null as any, slow: false, blocked: false, late: [] as (() => void)[] }));
vi.mock('../src/api', () => ({
  riskGuard: { blocked: () => h.blocked },
  fetchView: (id: string, cb: (x: any) => void) => { h.calls.push('view:' + id); if (h.slow) h.late.push(() => cb(h.view)); else cb(h.view); },
  fetchTags: (id: string, cb: (x: any) => void) => { h.calls.push('tag:' + id); if (h.slow) h.late.push(() => cb(h.tags)); else cb(h.tags); },
  fetchCard: (id: string, cb: (x: any) => void) => { h.calls.push('card:' + id); cb(h.card); },
}));
import { CONFIG, DEFAULT_CONFIG } from '../src/config';
import { rebuildRules } from '../src/match/engine';
import { dataVerdict, evaluateVideo, FILTER_WAIT_MS, immediateVerdict, videoNeeds } from '../src/video-filter';
import { filterFeedJsonAsync } from '../src/net';
import { normFeedItem } from '../src/cardinfo';
import { rememberMetadata } from '../src/metadata-cache';
let seq = 0;
const item = () => ({ bvid: 'BV1filter' + seq++, title: '普通视频', owner: { mid: 123, name: '作者' }, stat: { view: 1000, like: 50 }, duration: 30 });
const info = () => normFeedItem(item())!;
const url = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?ps=12&w_rid=unchanged';
beforeEach(() => {
  Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG));
  CONFIG.apiFilters = true;
  CONFIG.allowMetadataRequests = true;
  h.calls.length = h.late.length = 0;
  h.tags = null; h.view = null; h.card = null; h.slow = h.blocked = false;
  rebuildRules();
});
afterEach(() => vi.useRealTimers());

describe('渲染前的视频判定', () => {
  it('默认本地模式下所有精确规则均不补发接口、不等待空白格', async () => {
    CONFIG.allowMetadataRequests = false;
    CONFIG.block.tags.push('标签'); CONFIG.block.upBio.push('简介'); CONFIG.hideCharging = true; CONFIG.block.partitions.push('游戏'); rebuildRules();
    const v = await evaluateVideo(info()); expect(v.reason).toBeNull(); expect(v.deferred).toBe(true); expect(h.calls).toHaveLength(0);
  });
  it('被动缓存的标签在渲染前命中；迟到缓存不重新隐藏本批已放行卡片', async () => {
    CONFIG.allowMetadataRequests = false; CONFIG.block.tags.push('标签'); rebuildRules();
    const known = info(); rememberMetadata('t', known.bvid, ['标签']);
    expect((await evaluateVideo(known)).reason).toBe('标签:标签');
    const shown = info(); expect((await evaluateVideo(shown)).reason).toBeNull(); rememberMetadata('t', shown.bvid, ['标签']);
    expect((await evaluateVideo(shown)).reason).toBeNull();
    expect((await evaluateVideo(shown, Date.now() + 8000, true)).reason).toBe('标签:标签'); expect(h.calls).toHaveLength(0);
  });
  it('本地模式未识别 UID / 分区白名单时保守放行，不误伤白名单', async () => {
    CONFIG.allowMetadataRequests = false; CONFIG.allow.uids.push('777'); CONFIG.block.keywords.push('屏蔽词'); rebuildRules();
    expect((await evaluateVideo({ ...info(), uid: '', title: '屏蔽词' })).reason).toBeNull(); expect(h.calls).toHaveLength(0);
  });
  it('标签命中在响应交还前删除，游标/原数组身份/保留项顺序不变', async () => {
    CONFIG.block.tags.push('屏蔽标签'); rebuildRules(); h.tags = ['屏蔽标签'];
    const blocked = item(); const allowed = item(); allowed.owner.mid = 456;
    CONFIG.allow.uids.push('456'); rebuildRules();
    const arr = [allowed, blocked]; const json = { code: 0, data: { item: arr, cursor: 'native', has_more: true } };
    expect(await filterFeedJsonAsync(url, json)).toBe(1);
    expect(json.data.item).toBe(arr);
    expect(arr).toEqual([allowed]);
    expect(json.data.cursor).toBe('native'); expect(json.data.has_more).toBe(true);
    expect(h.calls).toEqual(['tag:' + blocked.bvid]);
  });
  it('简介只取 UP 卡片，已有 UID 时不浪费视频详情请求', async () => {
    CONFIG.block.upBio.push('博彩'); rebuildRules(); h.card = { card: { sign: '博彩推广' } };
    expect((await evaluateVideo(info())).reason).toBe('UP简介:博彩');
    expect(h.calls).toEqual(['card:123']);
  });
  it('缺失分区和 UID 用详情补全，然后走同一套本地规则', async () => {
    CONFIG.block.partitions.push('单机游戏'); rebuildRules(); h.view = { tname: '单机游戏', owner: { mid: 123 } };
    expect((await evaluateVideo(info())).reason).toBe('分区:单机游戏');
  });
  it('已有点赞数时不额外请求详情；充电专属仍需详情', () => {
    CONFIG.block.minLikes = 20; rebuildRules();
    expect(videoNeeds(info()).needView).toBe(false);
    CONFIG.hideCharging = true;
    expect(videoNeeds(info()).needView).toBe(true);
  });
  it('精确过滤关闭完全不发请求', async () => {
    CONFIG.apiFilters = false; CONFIG.block.tags.push('屏蔽标签'); rebuildRules();
    expect((await evaluateVideo(info())).reason).toBeNull(); expect(h.calls).toHaveLength(0);
  });
  it('缺 UID 时先补齐白名单，不能先按标题误删', async () => {
    const i = { ...info(), uid: '', title: '屏蔽词' };
    CONFIG.block.keywords.push('屏蔽词'); CONFIG.allow.uids.push('123'); rebuildRules();
    h.view = { owner: { mid: 123, name: '作者' } };
    expect(immediateVerdict(i)).toBeNull();
    expect((await evaluateVideo(i)).reason).toBeNull();
  });
  it('同视频数据层和 DOM 共享在途判定，结束后不再重发', async () => {
    CONFIG.block.tags.push('屏蔽标签'); rebuildRules(); const i = info();
    const [a, b] = await Promise.all([evaluateVideo(i), evaluateVideo(i)]);
    expect(a).toBe(b); expect(h.calls).toHaveLength(1);
    await evaluateVideo(i); expect(h.calls).toHaveLength(1);
  });
  it('风控时立即放行，不往熔断队列堆请求', async () => {
    CONFIG.block.tags.push('屏蔽标签'); rebuildRules(); h.blocked = true;
    expect((await evaluateVideo(info())).reason).toBeNull(); expect(h.calls).toHaveLength(0);
  });
  it('超时放行后迟到命中不能改写本批结论、让已显示卡片消失', async () => {
    vi.useFakeTimers(); CONFIG.block.tags.push('屏蔽标签'); rebuildRules(); h.slow = true; h.tags = ['屏蔽标签'];
    const i = info(); const p = evaluateVideo(i);
    await vi.advanceTimersByTimeAsync(FILTER_WAIT_MS);
    const first = await p; expect(first.reason).toBeNull();
    h.late.forEach((f) => f()); await Promise.resolve(); await Promise.resolve();
    expect(dataVerdict(i.bvid)).toBe(first); expect((await evaluateVideo(i)).reason).toBeNull();
  });
  it('规则变更不会复用旧版本的放行结论', async () => {
    const i = info(); await evaluateVideo(i); CONFIG.block.bvids.push(i.bvid); rebuildRules();
    expect(dataVerdict(i.bvid)).toBeNull(); expect((await evaluateVideo(i)).reason).toBe('BV:' + i.bvid);
  });
  it('超时后的下一批响应会重新判定，不把临时放行永久缓存', async () => {
    CONFIG.block.tags.push('屏蔽标签'); rebuildRules(); h.blocked = true;
    const i = info(); expect((await evaluateVideo(i)).deferred).toBe(true);
    h.blocked = false; h.tags = ['屏蔽标签'];
    expect((await evaluateVideo(i, Date.now() + FILTER_WAIT_MS, true)).reason).toBe('标签:屏蔽标签');
  });
  it('同 BV 的动态正文/转发者不同，不串用普通推荐的结论', async () => {
    const original = info(); await evaluateVideo(original);
    CONFIG.block.keywords.push('屏蔽词'); CONFIG.block.uids.push('456'); rebuildRules(); await evaluateVideo(original);
    expect((await evaluateVideo({ ...original, title: original.title + ' 屏蔽词' })).reason).toBe('关键词:屏蔽词');
    expect((await evaluateVideo({ ...original, uid: '456' })).reason).toBe('UID:456');
  });
  it('异步取数时暂停插件/加入白名单，不得应用旧命中', async () => {
    CONFIG.block.tags.push('屏蔽标签'); rebuildRules(); h.slow = true; h.tags = ['屏蔽标签'];
    const i = info(); const p = evaluateVideo(i); CONFIG.enabled = false; rebuildRules(); h.late.forEach((f) => f());
    expect((await p).reason).toBeNull();
  });
  it('在途请求不能给新加入的规则缓存不完整的“已放行”判定', async () => {
    CONFIG.block.tags.push('标签'); rebuildRules(); h.slow = true; h.tags = ['普通'];
    const i = info(); const p = evaluateVideo(i);
    CONFIG.block.upBio.push('博彩'); rebuildRules(); h.late.forEach((f) => f()); await p;
    expect(dataVerdict(i.bvid)).toBeNull();
    h.slow = false; h.card = { card: { sign: '博彩推广' } };
    expect((await evaluateVideo(i)).reason).toBe('UP简介:博彩');
  });
});
