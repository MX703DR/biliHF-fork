// 首页原生楼层骨架/加载哨兵不是视频数组的一部分。适配原生渲染模型，在 Vue patch 之前
// 移除命中项、把隐形楼层占位换成同页的原生视频骨架；不改卡片 UI、不补拉推荐。
import { CONFIG } from './config';
import { normFeedItem } from './cardinfo';
import { dataVerdict, immediateVerdict } from './video-filter';
import { recordBlock } from './stats';
import { logErr } from './logging';

const NAMES = new Set(['RecommendContainer_FloorAside', 'RecommendContainer_Overseas']);
const adapters = new Set<any>();
const counted = new Set<string>();
const hasClass = (node: any, name: string) => typeof node?.props?.class === 'string' && node.props.class.split(/\s+/).includes(name);
// Vue 模板里的裸 Boolean 属性在 VNode 中是空字符串，不能按 truthy 判断。
const isSkeleton = (props: any) => props?.skeleton === true || props?.skeleton === '';
const cloneChildren = (node: any, children: any) => ({ ...node, children, dynamicChildren: null, patchFlag: -2 });

function blocked(item: any): boolean {
  const info = normFeedItem(item);
  if (!info) return false;
  const v = dataVerdict(info.bvid, info.title, info.uid) || immediateVerdict(info);
  if (!v?.reason) return false;
  const key = v.version + ':' + (info.bvid || info.uid + ':' + info.title);
  if (!counted.has(key)) {
    counted.add(key);
    if (counted.size > 2000) counted.delete(counted.values().next().value!);
    recordBlock(v.reason, v.info, 'NET');
  }
  return true;
}

/** 保留哨兵的 DOM、ref 和 IntersectionObserver，不能直接删除它或把它挪到网格之外。 */
export function adaptHomeRender(tree: any, videoTemplate?: any): any {
  if (!CONFIG.enabled || CONFIG.reviewMode) return tree;
  let template = videoTemplate;
  const floorTypes = new Set<any>();
  const discover = (node: any) => {
    if (Array.isArray(node)) { node.forEach(discover); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type?.name === 'BiliVideoCard') template ||= node;
    if (hasClass(node, 'load-more-anchor') && Array.isArray(node.children)) {
      for (const ch of node.children) if (isSkeleton(ch?.props) && ch.type && typeof ch.type === 'object') floorTypes.add(ch.type);
    }
    if (Array.isArray(node.children)) node.children.forEach(discover);
  };
  const visit = (node: any): any => {
    if (Array.isArray(node)) {
      discover(node);
      return node.map(visit).filter((x) => x !== null);
    }
    if (!node || typeof node !== 'object' || !node.__v_isVNode) return node;
    const p = node.props;
    // actual floor 类型可以从 info.isFloor 识别；骨架类型从同一棵树的哨兵识别。
    if (p?.info?.isFloor) floorTypes.add(node.type);
    if (isSkeleton(p) && template && floorTypes.has(node.type)) {
      return { ...template, key: node.key, props: { skeleton: true, animation: p.animation },
        scopeId: node.scopeId, slotScopeIds: node.slotScopeIds,
        ref: null, el: null, component: null, children: null, dynamicChildren: null, patchFlag: -2 };
    }
    let out = node;
    if (p?.info?.isFloor && Array.isArray(p.info.list)) {
      const list = p.info.list.filter((item: any) => !blocked(item));
      if (!list.length) return null;
      if (list.length !== p.info.list.length) out = { ...node, props: { ...p, info: { ...p.info, list,
        displayItem: list.includes(p.info.displayItem) ? p.info.displayItem : list[0] } }, dynamicChildren: null, patchFlag: -2 };
    } else if (p?.info && !isSkeleton(p) && ['FeedCard', 'BiliVideoCard', 'BiliLiveCard'].includes(node.type?.name) && blocked(p.info)) return null;
    if (Array.isArray(out.children)) {
      const children = visit(out.children);
      if (hasClass(out, 'feed-card') && children.length === 0) return null;
      out = cloneChildren(out, children);
    } else if (out.children && typeof out.children === 'object') {
      // ClientOnly 的默认插槽稍后才执行，须在插槽返回 VNode 后、原生 patch 前适配。
      const slots = { ...out.children };
      for (const key of Object.keys(slots)) if (typeof slots[key] === 'function') {
        const original = slots[key];
        const wrapped = (...args: any[]) => visit(original(...args));
        Object.assign(wrapped, original);
        slots[key] = wrapped;
      }
      // 原生编译插槽标为 STABLE(1)，Vue 会沿用旧函数；适配后的插槽必须标为 DYNAMIC(2)。
      slots._ = 2;
      delete slots.$stable;
      out = cloneChildren(out, slots);
    }
    return out;
  };
  discover(tree);
  return visit(tree);
}

function attach(app: any): void {
  let videoTemplate: any;
  const instances: any[] = [];
  const seen = new Set<any>();
  const walk = (node: any) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node.type?.name === 'BiliVideoCard') videoTemplate ||= node;
    if (node.component) {
      if (NAMES.has(node.component.type?.__name)) instances.push(node.component);
      walk(node.component.subTree);
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(app?._container?._vnode);
  for (const instance of instances) {
    if (adapters.has(instance) || typeof instance.render !== 'function' || !videoTemplate) continue;
    const original = instance.render;
    instance.render = function (this: any, ...args: any[]) {
      const tree = original.apply(this, args);
      try { return adaptHomeRender(tree, videoTemplate); } catch (e) { logErr('首页渲染适配', e); return tree; }
    };
    adapters.add(instance);
    instance.proxy?.$forceUpdate?.();
  }
}

export function refreshHomeGrid(): void {
  for (const instance of adapters) {
    if (instance.isUnmounted) adapters.delete(instance);
    else instance.proxy?.$forceUpdate?.();
  }
}

/** 捕捉 Vue 在 root 上发布 app 的同一个微任务；安装后立即重绘，避免 250ms DOM 轮询。 */
export function installHomeGrid(): void {
  if (location.hostname !== 'www.bilibili.com' || location.pathname !== '/') return;
  const watched = new WeakSet<Element>();
  const inspect = () => {
    for (const root of document.querySelectorAll('#app, #i_cecream')) {
      if (watched.has(root)) continue;
      watched.add(root);
      const r = root as any;
      if (r.__vue_app__) { attach(r.__vue_app__); continue; }
      const d = Object.getOwnPropertyDescriptor(r, '__vue_app__');
      if (d && (!d.configurable || d.get || d.set)) continue;
      let app: any;
      Object.defineProperty(r, '__vue_app__', { configurable: true, enumerable: true, get: () => app,
        set: (value) => { app = value; try { attach(value); } catch (e) { logErr('首页组件发现', e); } } });
    }
  };
  inspect();
  const observer = new MutationObserver(inspect);
  observer.observe(document, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 15000);
}
