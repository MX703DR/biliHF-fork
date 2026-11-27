// 首页 FeedCard 的原生 Web 反馈回调已经绑定了稿件 ID、推荐 track_id 和当前登录会话。
// 不自行重建请求，不在自动过滤路径调用。
import { logErr } from './logging';
import { getCookie } from './util';
import { riskGuard } from './api';
import { isBilibiliHome } from './page';

interface NativeFeedback {
  info: { bvid: string; goto: string; dislike_switch?: boolean | number };
  onClickNointerest?: (option: { text: string; value: number; reason: number }) => unknown;
}

export function findNativeHomeFeedback(root: any, card: Element, bvid: string): NativeFeedback | undefined {
  const seen = new Set<unknown>();
  const walk = (node: any): NativeFeedback | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const props: NativeFeedback | undefined = node.props;
    if (node.el === card && node.type?.name === 'BiliVideoCard' && props?.info?.bvid === bvid &&
        props.info.goto === 'av' && props.info.dislike_switch && typeof props.onClickNointerest === 'function') return props;
    const subtree = walk(node.component?.subTree) || walk(node.suspense?.activeBranch);
    if (subtree) return subtree;
    if (Array.isArray(node.children)) for (const child of node.children) {
      const match = walk(child);
      if (match) return match;
    }
  };
  return walk(root);
}

const sentCards = new WeakMap<Element, string>();

export function sendHomeBlockFeedback(card: Element, bvid: string): void {
  try {
    if (!isBilibiliHome() || !card.isConnected ||
        !/^BV[0-9A-Za-z]+$/.test(bvid) || sentCards.get(card) === bvid || riskGuard.blocked() || !getCookie('bili_jct')) return;
    // 确认菜单打开之后卡片没有被换一换或 Vue 复用为另一稿件。
    const href = card.querySelector('a[href*="/video/"]')?.getAttribute('href');
    if (href?.match(/\/video\/(BV[0-9A-Za-z]+)(?=[/?#]|$)/)?.[1] !== bvid) return;
    for (const root of document.querySelectorAll('#app, #i_cecream')) {
      const nativeRoot = root as Element & { _vnode?: unknown; __vue_app__?: { _container?: { _vnode?: unknown } } };
      const native = findNativeHomeFeedback(nativeRoot._vnode ?? nativeRoot.__vue_app__?._container?._vnode, card, bvid);
      if (!native?.onClickNointerest) continue;
      sentCards.set(card, bvid);
      // 两条是原站的独立理由。逐个调用，一个失败不阻断另一个，也不重试。
      for (const option of [
        { text: '内容不感兴趣', value: 1, reason: 1 },
        { text: '不想看此UP主', value: 2, reason: 4 },
      ]) {
        try {
          void Promise.resolve(native.onClickNointerest(option)).catch((e) => logErr('首页屏蔽反馈', e));
        } catch (e) { logErr('首页屏蔽反馈', e); }
      }
      return;
    }
  } catch (e) { logErr('首页屏蔽反馈', e); }
}
