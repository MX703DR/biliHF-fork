import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendHomeBlockFeedback } from '../src/home-feedback';

const risk = vi.hoisted(() => ({ blocked: vi.fn(() => false) }));
vi.mock('../src/api', () => ({ riskGuard: risk }));

const bvid = 'BV1xx411c7mD';
function setup({ url = 'https://www.bilibili.com/', cookie = 'bili_jct=test-token', goto = 'av', enabled = true, href = '/video/' + bvid, connected = true, cardBvid = bvid } = {}) {
  const card = { isConnected: connected, querySelector: () => ({ getAttribute: () => href }) } as unknown as Element;
  const feedback = vi.fn();
  const vnode = { el: card, type: { name: 'BiliVideoCard' }, props: {
    info: { bvid: cardBvid, goto, dislike_switch: enabled }, onClickNointerest: feedback,
  } };
  // 覆盖生产 Vue 的组件子树与 Suspense 激活分支，而不是依赖开发模式 DOM 的 expando。
  const root = { __vue_app__: { _container: { _vnode: { component: { subTree: { suspense: { activeBranch: { children: [vnode] } } } } } } } };
  vi.stubGlobal('location', new URL(url));
  vi.stubGlobal('document', { cookie, querySelectorAll: () => [root] });
  return { card, feedback };
}

afterEach(() => { risk.blocked.mockReturnValue(false); vi.unstubAllGlobals(); });

describe('首页原生屏蔽反馈', () => {
  it('精确使用 PC 的两种理由，同一张卡不重复提交', () => {
    const { card, feedback } = setup();
    sendHomeBlockFeedback(card, bvid);
    sendHomeBlockFeedback(card, bvid);
    expect(feedback.mock.calls).toEqual([
      [{ text: '内容不感兴趣', value: 1, reason: 1 }],
      [{ text: '不想看此UP主', value: 2, reason: 4 }],
    ]);
  });

  it.each([
    { url: 'https://search.bilibili.com/' },
    { url: 'https://www.bilibili.com/video/' + bvid },
    { cookie: '' },
    { goto: 'ad' },
    { enabled: false },
    { connected: false },
    { href: '/video/BVdifferent' },
    { cardBvid: 'BVdifferent' },
  ])('不对不兼容的上下文发送反馈：%j', options => {
    const { card, feedback } = setup(options);
    sendHomeBlockFeedback(card, bvid);
    expect(feedback).not.toHaveBeenCalled();
  });

  it('风控期间跳过，不补发', () => {
    const { card, feedback } = setup();
    risk.blocked.mockReturnValue(true);
    sendHomeBlockFeedback(card, bvid);
    expect(feedback).not.toHaveBeenCalled();
  });
});
