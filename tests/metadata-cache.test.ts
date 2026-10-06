import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { METADATA_KEY } from '../src/constants';
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); (globalThis as any).__gmClear(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('被动本地元数据缓存', () => {
  it('原生详情响应精简入库，标签/简介本地可读，密码 Cookie staff 不保存', async () => {
    const m = await import('../src/metadata-cache');
    m.observeMetadata('https://api.bilibili.com/x/web-interface/view/detail?bvid=BVtest', { code: 0, data: {
      View: { bvid: 'BVtest', tname: '游戏', owner: { mid: 7, name: '作者' }, staff: [{ mid: 8 }], cookie: 'secret', is_upower_exclusive: 1 },
      Tags: [{ tag_name: '标签' }], Card: { card: { mid: 7, name: '作者', sign: '简介', password: 'secret' } },
    } });
    const local = m.cachedMetadata('BVtest');
    expect(local.tags).toEqual(['标签']); expect(local.view.is_upower_exclusive).toBe(true); expect(local.card.card.sign).toBe('简介');
    vi.advanceTimersByTime(2001);
    const stored = GM_getValue(METADATA_KEY, '');
    expect(stored).not.toContain('secret'); expect(stored).not.toContain('staff');
    vi.resetModules(); const reloaded = await import('../src/metadata-cache');
    expect(reloaded.cachedMetadata('BVtest').tags).toEqual(['标签']);
  });
  it('失败 / 非 B 站域名响应不写入', async () => {
    const m = await import('../src/metadata-cache');
    const url = 'https://api.bilibili.com/x/web-interface/view?bvid=BVtest';
    m.observeMetadata(url, { code: -352, data: { bvid: 'BVtest' } });
    m.observeMetadata(url.replace('api.bilibili.com', 'evil.example'), { code: 0, data: { bvid: 'BVtest' } });
    expect(m.cachedMetadata('BVtest').view).toBeNull();
  });
  it('推荐流的部分字段不覆盖已知分区 / 充电标志；转发作者不污染视频 owner', async () => {
    const m = await import('../src/metadata-cache'); const { normFeedItem, normDynamicItem } = await import('../src/cardinfo');
    m.rememberMetadata('v', 'BVtest', { owner: { mid: 7 }, tname: '游戏', is_upower_exclusive: false, stat: { like: 100 } });
    m.rememberFeedMetadata(normFeedItem({ bvid: 'BVtest', title: '视频', stat: { view: 200 } })!);
    m.rememberFeedMetadata(normDynamicItem({ modules: { module_author: { mid: 99 }, module_dynamic: { major: { archive: { bvid: 'BVtest' } } } } })!);
    expect(m.cachedMetadata('BVtest').view).toMatchObject({ owner: { mid: '7' }, tname: '游戏', is_upower_exclusive: false, stat: { like: 100, view: 200 } });
  });
  it('简介一天、视频和标签七天过期，不永久使用陈旧字段', async () => {
    const m = await import('../src/metadata-cache');
    m.rememberMetadata('v', 'BVtest', { owner: { mid: 7 } }); m.rememberMetadata('t', 'BVtest', ['标签']); m.rememberMetadata('c', '7', { sign: '简介' });
    vi.advanceTimersByTime(86400001); expect(m.cachedMetadata('BVtest').card).toBeNull(); expect(m.cachedMetadata('BVtest').tags).toEqual(['标签']);
    vi.advanceTimersByTime(7 * 86400000); expect(m.cachedMetadata('BVtest').view).toBeNull(); expect(m.cachedMetadata('BVtest').tags).toBeNull();
  });
  it('损坏 / 非法缓存被忽略，不影响规则', async () => {
    GM_setValue(METADATA_KEY, '{broken'); const m = await import('../src/metadata-cache'); expect(m.cachedMetadata('BVtest').view).toBeNull();
  });
});
