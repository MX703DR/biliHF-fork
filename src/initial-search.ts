// 视频搜索首屏会把 store.result 转换成组件本地列表，只改 store 不会同步那份副本。
// 复用原生 submitSearch 控制器，用已判定的同页 SSR 数据回放一次；不发额外请求、不改 UI。
export interface SearchReplayContext { keyword: string; page: number; isCurrent: () => boolean; waitMs?: number }

export function nativeSearchEvents(app: any): any | null {
  const provides = (app?._instance || app?._container?._vnode?.component)?.provides;
  for (const key of Reflect.ownKeys(provides || {})) {
    const bus = provides[key];
    if (typeof bus?.emit === 'function' && typeof bus?.all?.has === 'function' && bus.all.has('submitSearch')) return bus;
  }
  return null;
}

export function replayInitialVideoSearch(app: any, state: any, context: SearchReplayContext): Promise<boolean> {
  const store = state?.searchTypeResponse;
  const snapshot = store?.searchTypeResponse;
  const original = store?.querySearchByType;
  const bus = nativeSearchEvents(app);
  if (!bus || typeof original !== 'function' || !Array.isArray(snapshot?.result) || !context.isCurrent()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let finished = false;
    const restore = () => { if (store.querySearchByType === wrapped) store.querySearchByType = original; };
    const finish = (replayed: boolean) => { if (finished) return; finished = true; clearTimeout(timer); restore(); resolve(replayed); };
    const wrapped = function (this: any, params: any, ...rest: any[]) {
      restore(); // 仅消费一次；任何后续搜索/翻页都恢复原生 action。
      if (!context.isCurrent() || params?.search_type !== 'video' || params.keyword !== context.keyword || Number(params.page) !== context.page) {
        finish(false);
        return original.apply(this, [params, ...rest]);
      }
      // 原生 await action 后会设置本地列表；把释放闸门排到该续体和 Vue 更新之后。
      queueMicrotask(() => queueMicrotask(() => finish(true)));
      return Promise.resolve(snapshot);
    };
    const timer = setTimeout(() => finish(false), context.waitMs ?? 500);
    try { store.querySearchByType = wrapped; bus.emit('submitSearch'); } catch (e) { finish(false); }
  });
}
