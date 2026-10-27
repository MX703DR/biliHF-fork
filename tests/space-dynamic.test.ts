import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import meta from '../src/meta.js?raw';
import { pageType, cellOf, isUnsafeHideTarget, VIDEO_CARD_SELECTOR } from '../src/page';
import { extractCardInfo, normDynamicItem } from '../src/cardinfo';
import { CONFIG, DEFAULT_CONFIG } from '../src/config';
import { rebuildRules } from '../src/match/engine';
import { filterFeedJson, filterFeedJsonAsync } from '../src/net';
import { fromHtml, h, installDocument } from './helpers/dom';
import dynamic from './fixtures/dynamic.json';
import spaceCard from './fixtures/html/space-dynamic-card.html?raw';

const spaceUrl = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=100003&offset=900000000000000000&w_rid=signed';
const card = () => fromHtml(spaceCard, VIDEO_CARD_SELECTOR);
function bindData(el: ReturnType<typeof card>, data: any, vue3 = false): void {
  Object.assign(el.querySelector('.bili-dyn-item')!, vue3 ? { __vueParentComponent: { props: { data } } } : { __vue__: { $props: { data } } });
}

beforeEach(() => { Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG)); rebuildRules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('个人空间动态的脚本入口', () => {
  it('注入空间整个域名，不能只匹配 dynamic：站内切换不会重新注入脚本', () => {
    expect(meta).toMatch(/^\/\/ @match\s+https:\/\/space\.bilibili\.com\/\*\r?$/m);
    for (const host of ['www', 'search', 't']) expect(meta).toContain(`https://${host}.bilibili.com/*`);
  });
  it.each(['/123/dynamic', '/123/dynamic/', '/123/dynamic?tab=video#top'])('识别空间动态 %s', path => {
    vi.stubGlobal('location', new URL('https://space.bilibili.com' + path));
    expect(pageType()).toBe('动态');
  });
  it('从空间主页 SPA 切换动态，再切走时实时判定，不能缓存初始路径', () => {
    vi.stubGlobal('location', new URL('https://space.bilibili.com/123'));
    expect(pageType()).toBe('其他');
    vi.stubGlobal('location', new URL('https://space.bilibili.com/123/dynamic'));
    expect(pageType()).toBe('动态');
    vi.stubGlobal('location', new URL('https://space.bilibili.com/123/upload'));
    expect(pageType()).toBe('其他');
  });
  it('保留原动态域名，且不把空间其他路径误判为动态', () => {
    vi.stubGlobal('location', new URL('https://t.bilibili.com/123'));
    expect(pageType()).toBe('动态');
    vi.stubGlobal('location', new URL('https://space.bilibili.com/123/dynamic-preview'));
    expect(pageType()).toBe('其他');
  });
});

describe('空间动态 DOM 与本地组件数据', () => {
  it.each([false, true])('作者没有链接时，按单卡原始数据取发布者 UID，不误取转发作者（Vue3=%s）', vue3 => {
    const el = card(); bindData(el, structuredClone(dynamic.data.items[2]), vue3);
    expect(extractCardInfo(el as any)).toMatchObject({ uid: '100003', up: '样本UP丙', isDynamic: true,
      title: '转发一下 原神最新爆料汇总' });
  });
  it('从本地 props 获得视频 BV、时长和播放数，不串用动态点赞量', () => {
    const el = card(); bindData(el, dynamic.data.items[0]);
    expect(extractCardInfo(el as any)).toMatchObject({ uid: '100001', bvid: 'BV1dd411d1d1', duration: 615, views: 523000, likes: null });
  });
  it('组件复用后重新读取当前发布者，不保留上张动态的 UID', () => {
    const el = card(); bindData(el, dynamic.data.items[0]);
    expect(extractCardInfo(el as any).uid).toBe('100001');
    bindData(el, dynamic.data.items[2]);
    expect(extractCardInfo(el as any).uid).toBe('100003');
  });
  it('无组件数据仍读取正文与转发正文，未知 UID 留空，绝不从正文 @ 链接猜发布者', () => {
    const el = card(); el.querySelector('.bili-dyn-content')!.appendChild(h('a', '', { href: '//space.bilibili.com/999' }, '@其他人'));
    el.querySelector('.bili-dyn-item__footer')!.appendChild(h('div', 'bili-rich-text__content', {}, '评论中的无关关键词'));
    const info = extractCardInfo(el as any);
    expect(info).toMatchObject({ up: '样本UP丙', uid: '', isDynamic: true, title: '转发一下 原神最新爆料汇总' });
    expect(info.title).not.toContain('评论中的无关关键词');
  });
  it('组件属性读取失败时退回 DOM，不让一张卡中断扫描或右键', () => {
    const el = card(); Object.defineProperty(el.querySelector('.bili-dyn-item')!, '__vue__', { get() { throw new Error('unknown component'); } });
    expect(extractCardInfo(el as any).up).toBe('样本UP丙');
  });
  it('隐藏目标只是一条动态，不是整个列表或无限加载哨兵', () => {
    const el = card(); const restore = installDocument(h('body', '', {}, el));
    try { expect(cellOf(el as any)).toBe(el); expect(isUnsafeHideTarget(el as any)).toBe(false); }
    finally { restore(); }
  });
});

describe('空间动态数据层过滤', () => {
  it('只删命中 UID 的动态，分页 offset/has_more 保持原样', async () => {
    CONFIG.block.uids.push('100002'); rebuildRules();
    const json = structuredClone(dynamic); const cursor = json.data.offset;
    expect(await filterFeedJsonAsync(spaceUrl, json)).toBe(1);
    expect(json.data.items.map(x => x.id_str)).toEqual(['900000000000000001', '900000000000000003']);
    expect(json.data.offset).toBe(cursor); expect(json.data.has_more).toBe(true);
  });
  it('屏蔽转发正文关键字，同时保留发布者白名单优先级', () => {
    CONFIG.block.keywords.push('爆料'); CONFIG.allow.uids.push('100003'); rebuildRules();
    expect(filterFeedJson(spaceUrl, structuredClone(dynamic))).toBe(0);
    CONFIG.allow.uids = []; rebuildRules();
    expect(filterFeedJson(spaceUrl, structuredClone(dynamic))).toBe(1);
  });
  it('新版图文 opus 的标题和 summary.text 都参与过滤', () => {
    const item = { id_str: '101', type: 'DYNAMIC_TYPE_DRAW', modules: { module_author: { mid: 100004, name: '图文作者' },
      module_dynamic: { desc: null, major: { opus: { title: '图文标题', summary: { text: '图文里需要屏蔽的正文' } } } } } };
    expect(normDynamicItem(item)?.title).toBe('图文标题 图文里需要屏蔽的正文');
    CONFIG.block.keywords.push('需要屏蔽'); rebuildRules();
    expect(filterFeedJson(spaceUrl, { code: 0, data: { items: [item] } })).toBe(1);
  });
  it('视频的附加动态正文不被视频标题覆盖', () => {
    const item = structuredClone(dynamic.data.items[0]) as any;
    item.modules.module_dynamic.desc = { text: '单独动态文案' };
    expect(normDynamicItem(item)?.title).toBe('【原神】新角色实机演示 单独动态文案');
  });
  it.each(['paused', 'review'])('%s 时不在数据层删动态', mode => {
    CONFIG.block.uids.push('100002'); CONFIG.enabled = mode !== 'paused'; CONFIG.reviewMode = mode === 'review'; rebuildRules();
    const json = structuredClone(dynamic);
    expect(filterFeedJson(spaceUrl, json)).toBe(0); expect(json.data.items).toHaveLength(3);
  });
});
