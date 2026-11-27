import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/config';
import { ATTR_BLOCKED, PROCESSED } from '../src/constants';
import * as cards from '../src/cardinfo';
import * as filtering from '../src/video-filter';
import { inspectChangedCard } from '../src/dom';

const initialReview = CONFIG.reviewMode;
afterEach(() => { CONFIG.reviewMode = initialReview; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('审查标签被原生重绘清除后修复', () => {
  it.each([
    { review: true, blocked: true, outlined: true, tag: false, repair: true },
    { review: true, blocked: true, outlined: false, tag: true, repair: true },
    { review: true, blocked: true, outlined: true, tag: true, repair: false },
    { review: false, blocked: true, outlined: true, tag: false, repair: false },
    { review: true, blocked: false, outlined: false, tag: false, repair: false },
  ])('%j', ({ review, blocked, outlined, tag, repair }) => {
    CONFIG.reviewMode = review;
    const info: cards.CardInfo = { title: '测试卡片', up: '作者', uid: '123', bvid: '', partition: '', duration: null, views: null, likes: null, isLive: false, isAd: false };
    vi.spyOn(cards, 'extractCardInfo').mockReturnValue(info);
    vi.spyOn(cards, 'cachedCardInfo').mockReturnValue(info);
    vi.spyOn(filtering, 'immediateVerdict').mockReturnValue({ info, reason: '关键词', version: 0 });
    // 这里只断言重新排队；DOM 实际提交/按钮操作由真实浏览器回归覆盖。
    vi.stubGlobal('queueMicrotask', () => {});
    const el: any = {
      nodeType: 1, isConnected: true, setAttribute: vi.fn(),
      closest: (selector: string) => selector.includes('div.bili-video-card') ? el : null,
      querySelector: () => tag ? {} : null,
      hasAttribute: (name: string) => name === PROCESSED || (name === ATTR_BLOCKED && blocked),
      classList: { contains: () => outlined },
    };
    inspectChangedCard(el);
    expect(el.setAttribute.mock.calls.some(([name]: string[]) => name === PROCESSED)).toBe(repair);
  });
});
