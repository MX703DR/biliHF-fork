// 网络拦截层（数据层过滤，主路径）：hook fetch / XHR，被动过滤 B 站自身请求的 JSON 列表，
// 把命中规则的项从数组删掉，让页面只渲染保留项；进阶规则也在响应交给页面之前完成。
import { CONFIG } from './config';
import { log, logErr } from './logging';
import { normDynamicItem, normFeedItem } from './cardinfo';
import type { CardInfo } from './cardinfo';
import { recordBlock } from './stats';
import { health } from './health';
import { dataVerdict, evaluateVideo, FILTER_WAIT_MS, immediateVerdict } from './video-filter';
import { filterCommentJson, isCommentUrl } from './comment-data';
import { installXhrHooks } from './net-xhr';
import { isMetadataUrl, observeMetadata } from './metadata-cache';

// 接口注册：re=URL 匹配，get=从 data 里取出可过滤的数组（就地 splice 即生效）。
// norm=把该接口的列表项归一成 CardInfo；不填则用 normFeedItem（推荐流那套扁平字段）。
// 动态流的响应结构与推荐流完全不同（字段埋在 modules 里），有了这个口子就不必让 normFeedItem
// 去认所有接口的形状——那会把一个纯函数变成大杂烩，且每加一个接口都要改它。
export interface FeedHook {
  re: RegExp;
  get: (d: any) => any[] | null;
  norm?: (it: any) => CardInfo | null;
  lists?: (d: any) => VideoSource[];
}
export interface VideoSource { items: any[]; norm?: (it: any) => CardInfo | null }

/** 搜索综合 / 视频页，以及用户卡片内的投稿预览；不删除用户卡片本身。 */
export function searchVideoSources(data: any): VideoSource[] {
  if (!Array.isArray(data?.result)) return [];
  const groups = data.result;
  if (!groups.length || !groups[0]?.result_type) {
    return !groups.length || groups.some((it: any) => it?.type === 'video' || it?.bvid)
      ? [{ items: groups }] : [];
  }
  const sources: VideoSource[] = [];
  for (const group of groups) {
    if (!Array.isArray(group?.data)) continue;
    if (group.result_type === 'video') sources.push({ items: group.data });
    if (group.result_type === 'bili_user' || group.result_type === 'user') {
      for (const user of group.data) if (Array.isArray(user?.res)) {
        sources.push({ items: user.res, norm: (it) => it && normFeedItem({ ...it, owner: { mid: user.mid, name: user.uname } }) });
      }
    }
  }
  return sources;
}
const feedSources = (hook: FeedHook, data: any): VideoSource[] => {
  if (hook.lists) return hook.lists(data);
  const items = hook.get(data);
  return items ? [{ items, norm: hook.norm }] : [];
};
export const FEED_HOOKS: FeedHook[] = [
  { re: /\/x\/web-interface\/wbi\/index\/top\/feed\/rcmd/, get: (d) => (d && Array.isArray(d.item) ? d.item : null) },
  { re: /\/x\/web-interface\/index\/top\/feed\/rcmd/, get: (d) => (d && Array.isArray(d.item) ? d.item : null) },
  { re: /\/x\/web-interface\/ranking\/v2/, get: (d) => (d && Array.isArray(d.list) ? d.list : null) },
  { re: /\/x\/web-interface\/popular(\/|\?|$)/, get: (d) => (d && Array.isArray(d.list) ? d.list : null) },
  { re: /\/x\/web-interface\/archive\/related/, get: (d) => (Array.isArray(d) ? d : null) },
  // 搜索页：type=视频 时 data.result 直接是视频数组；综合(all/v2) 时 data.result 是分组，取 result_type==='video' 的 data
  {
    re: /\/x\/web-interface\/(?:wbi\/)?search\/(type|all\/v2)/,
    get: (d) => {
      if (!d || !Array.isArray(d.result)) return null;
      if (d.result.length && d.result[0] && d.result[0].result_type) {
        const g = d.result.find((x: any) => x.result_type === 'video');
        return g && Array.isArray(g.data) ? g.data : null;
      }
      return searchVideoSources(d)[0]?.items || null;
    },
    lists: searchVideoSources,
  },
  // 动态流（t.bilibili.com）。此前这是唯一一个完全靠 DOM 兜底的主要页面——DOM 层只能在卡片
  // 画出来之后再隐藏，且抠不到 UID 这类权威字段。接到拦截层后与首页同源同判。
  // 只删 data.items 里的项，不动 offset/has_more：分页游标由 B 站维护，改它会打乱后续加载。
  { re: /\/x\/polymer\/web-dynamic\/v1\/feed\/(all|space)/, get: (d) => (d && Array.isArray(d.items) ? d.items : null), norm: normDynamicItem },
];

// hook 查找：单条 URL 通常会被查两次（钩子入口判定 + filterFeedJson 取数组），
// 用一格 memo 让第二次 O(1)，避免对整张 FEED_HOOKS 表重复跑正则。
let memoUrl: string | null = null;
let memoHook: FeedHook | null = null;
export function findFeedHook(url: string | null | undefined): FeedHook | null {
  if (!url) return null;
  if (url === memoUrl) return memoHook;
  let hit: FeedHook | null = null;
  for (const h of FEED_HOOKS) {
    if (h.re.test(url)) {
      hit = h;
      break;
    }
  }
  memoUrl = url;
  memoHook = hit;
  return hit;
}
const isFeedUrl = (url: string | null | undefined): boolean => !!findFeedHook(url);
const isFilteredUrl = (url: string): boolean => isFeedUrl(url) || isCommentUrl(url) || isMetadataUrl(url);

/** 对已知视频数组同步过滤（首屏状态 / 同步 XHR）；metadata 尚未就绪的留给异步闸门。 */
export function filterVideoList(arr: any[], norm: (it: any) => CardInfo | null = normFeedItem, record = (reason: string, info: CardInfo) => recordBlock(reason, info, 'NET')): number {
  if (!CONFIG.enabled || CONFIG.reviewMode) return 0;
  let removed = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    try {
      const info = norm(arr[i]);
      if (!info) continue;
      const verdict = dataVerdict(info.bvid, info.title, info.uid);
      const reason = verdict ? verdict.reason : immediateVerdict(info)?.reason;
      if (reason) {
        record(reason, verdict?.info || info);
        arr.splice(i, 1);
        removed++;
      }
    } catch (e) {
      log('拦截层 单项判定异常（已跳过）', e);
    }
  }
  return removed;
}

/** 整批判定完成后一次提交，不边取标签边把条目一张张交给页面。保留原数组身份、分页游标和顺序。 */
export async function prepareVideoList(arr: any[], norm: (it: any) => CardInfo | null = normFeedItem): Promise<void> {
  if (!CONFIG.enabled || CONFIG.reviewMode) return;
  const deadline = Date.now() + FILTER_WAIT_MS;
  health.pendingFilters++;
  try { await Promise.all(arr.map(async (item) => {
    try {
      const info = norm(item);
      if (info) await evaluateVideo(info, deadline, true);
    } catch (e) {
      log('拦截层 异步判定异常（已放行）', e);
    }
  })); } finally { health.pendingFilters--; }
}

// 就地过滤一个已解析的 JSON 响应：命中项从 json.data 的数组里原地 splice 删除。
// 返回删除条数（0 表示未改动），调用方据此决定是否需要重建响应/重序列化。
export function filterFeedJson(url: string, json: any): number {
  if (!json || json.code !== 0 || !json.data) return 0;
  const hook = findFeedHook(url);
  if (!hook) return 0;
  const sources = feedSources(hook, json.data);
  if (!sources.length) return 0;
  // 自检先于开关记账：这两个计数反映的是「管线还通不通」，与用户是否启用拦截无关。
  // B 站改字段名时 feedParsed 会停在 0，健康检查据此报警。
  health.feedParsed++;
  health.feedItems += sources.reduce((count, source) => count + source.items.length, 0);
  // 审查模式下不在数据层删项，让视频照常渲染，交给 DOM 层标记，便于核对
  let removed = 0;
  for (const { items, norm } of sources) {
    for (const it of items) if (it?.stat?.like != null || it?.stats?.like != null) health.feedLikes++;
    removed += filterVideoList(items, norm);
    health.feedKept += items.length;
  }
  if (removed) log(`拦截层 删除 ${removed} 项 @ ${url.split('?')[0]}`);
  return removed;
}

export async function filterFeedJsonAsync(url: string, json: any): Promise<number> {
  if (!json || json.code !== 0 || !json.data) return 0;
  const hook = findFeedHook(url);
  if (!hook) return 0;
  const sources = feedSources(hook, json.data);
  if (!sources.length) return 0;
  await Promise.all(sources.map(({ items, norm }) => prepareVideoList(items, norm)));
  // 配置可能在取数期间改变；最终提交仍走当前规则，不使用旧版本的异步命中。
  return filterFeedJson(url, json);
}

// 可插拔网络管线（以「JSON 原地过滤」为中心，fetch 与 XHR 共用一套）。
//   preFn:  (url) => newUrl|void   —— 渲染前改写请求 URL（仅处理字符串 URL）
//   postFn: (url, json) => removedCount —— 原地修改解析后的 JSON，返回删除条数
type PreFn = (url: string) => string | void;
type PostFn = (url: string, json: any) => number;

// 「这条请求已带 WBI 签名」的标记。
// wbi 接口把全部 query 参数排序后连同 mixin_key 一起 MD5 得出 w_rid，签名覆盖每一个参数——
// 签完再动任何一个（哪怕只是 ps=12 改成 ps=30），服务端校验必然对不上，直接 -403。
// 首页推荐早已迁到 wbi 路径（FEED_HOOKS 第一条），所以这不是理论风险。
//
// 兜底放在管线出口而不是某个 preFn 里：B 站把接口往 wbi 迁是持续在发生的事，按「有没有
// w_rid」这个确定性标记判定，才不会在下一次迁移时又悄悄破一遍。代价是相应的改写功能
// 在已签名接口上不生效——这由 health 显式报出来，而不是让用户对着刷不出的首页猜。
const SIGNED_RE = /[?&]w_rid=/;
const NET = (() => {
  const preFns: PreFn[] = [];
  const postFns: Array<{ sync: PostFn; async: (url: string, json: any) => number | Promise<number> }> = [];
  return {
    addPre: (fn: PreFn) => preFns.push(fn),
    addPost: (fn: PostFn, asyncFn: (url: string, json: any) => number | Promise<number> = fn) => postFns.push({ sync: fn, async: asyncFn }),
    hasPre: () => preFns.length > 0,
    rewriteUrl(url: string): string {
      let u = url;
      for (const fn of preFns) {
        try {
          const r = fn(u);
          if (typeof r === 'string' && r) u = r;
        } catch (e) {
          logErr('NET.pre', e); // 管线内异常不静默：改写失效会让 boostFeedLoad 之类的功能无声失灵
        }
      }
      // 已签名请求兜底（见 SIGNED_RE）：宁可这次改写不生效，也不能把请求改成必然 -403 的形状。
      if (u !== url && SIGNED_RE.test(url)) {
        health.signedSkipped++;
        return url;
      }
      return u;
    },
    runJson(url: string, json: any): number {
      let removed = 0;
      for (const fn of postFns) {
        try {
          removed += fn.sync(url, json) || 0;
        } catch (e) {
          logErr('NET.post', e); // 同上：过滤器整体抛错=该页不再拦截，必须可见
        }
      }
      return removed;
    },
    async runJsonAsync(url: string, json: any): Promise<number> {
      let removed = 0;
      for (const fn of postFns) {
        try { removed += (await fn.async(url, json)) || 0; } catch (e) { logErr('NET.post.async', e); }
      }
      return removed;
    },
  };
})();

/** 跑一遍请求改写管线（含已签名 URL 的兜底）。非字符串 URL 不处理，原样返回。 */
export function rewriteRequestUrl(url: string): string {
  return NET.hasPre() ? NET.rewriteUrl(url) : url;
}

// 首页推荐接口（增大加载数量用）。与 FEED_HOOKS 里的两条 rcmd 规则同源，避免两处各写一份。
// 保留 wbi/ 那一路的匹配：改写会被上面的 SIGNED_RE 兜底拦下并计数，比在这里假装 wbi 不存在
// 更诚实——用户开了开关却没效果时，自检能说出原因。未签名的旧路径上它照常生效。
const RCMD_RE = /\/x\/web-interface\/(wbi\/)?index\/top\/feed\/rcmd/;
let homeFeedEpoch = 0;
export function advanceHomeFeedEpoch(): void { homeFeedEpoch++; }
const homeRequestContext = (url: string): number | undefined =>
  RCMD_RE.test(url) && location.hostname === 'www.bilibili.com' && location.pathname === '/' ? homeFeedEpoch : undefined;

function discardStaleHomeFeed(json: any, context: unknown, note = true): number | null {
  if (typeof context !== 'number' || context === homeFeedEpoch) return null;
  const arr = json?.code === 0 && json.data?.item;
  if (!Array.isArray(arr)) return null;
  if (note) health.feedParsed++; // 已确认响应形状；丢弃过时批次不意味着管线解析失败。
  const count = arr.length;
  arr.length = 0;
  return count; // 过时的批次不是“规则屏蔽”，不计入屏蔽记录，也不能再追加回刚刷新的页面。
}

// 注册唯一的内容过滤 postFn（即 filterFeedJson）；以后新增过滤器只需再 addPost 一条。
NET.addPost(filterFeedJson, filterFeedJsonAsync);
NET.addPost(filterCommentJson);
NET.addPost((url, json) => { observeMetadata(url, json); return 0; });
// 注册「增大首页推荐请求数」preFn（默认关，opt-in）：拦截层会删项，调大 ps 可让信息流删后仍饱满。
NET.addPre((url) => {
  if (!CONFIG.boostFeedLoad) return;
  if (RCMD_RE.test(url) && /[?&]ps=\d+/.test(url)) {
    return url.replace(/([?&]ps=)\d+/, '$1' + 30);
  }
});

// 过滤文本响应：无删项时原样返回 raw（省一次序列化、且保持字节一致）。
async function filterResponseJson(url: string, json: any, context?: unknown): Promise<number> {
  const stale = discardStaleHomeFeed(json, context);
  if (stale !== null) return stale;
  const removed = await NET.runJsonAsync(url, json);
  return removed + (discardStaleHomeFeed(json, context, false) || 0);
}

export function installNetworkHooks(): void {
  const W: any = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // —— fetch ——
  const RespCtor = W.Response || Response;
  if (typeof W.fetch === 'function' && !W.fetch.__bfb) {
    const origFetch = W.fetch;
    const wrapped: any = function (this: unknown, input: any, init: any) {
      // 请求改写（preFn）：仅当输入是字符串 URL 时处理，避免重建 Request 对象的副作用
      let input2 = input;
      if (typeof input === 'string') input2 = rewriteRequestUrl(input);
      const url = typeof input2 === 'string' ? input2 : input2?.url || input2?.href || '';
      const signal = init?.signal || input?.signal;
      const context = homeRequestContext(url);
      const p = origFetch.call(this, input2, init);
      health.noteRequest(url);
      if (!isFilteredUrl(url)) return p;
      const feed = isFeedUrl(url);
      if (feed) { health.feedMatched++; health.pendingResponses++; }
      return p.then(async (resp: Response) => {
        const checkAbort = () => { if (signal?.aborted) throw signal.reason || new (W.DOMException || DOMException)('The operation was aborted.', 'AbortError'); };
        let json: any;
        try { json = await resp.clone().json(); } catch (e) { checkAbort(); return resp; }
        checkAbort();
        const changed = await filterResponseJson(url, json, context);
        checkAbort();
        // 无删项保留真实响应；取消请求不能被上面的解析容错误当成“正常放行”。
        if (!changed) return resp;
        const h = new (W.Headers || Headers)(resp.headers);
        h.delete('content-encoding');
        h.delete('content-length');
        const filtered = new RespCtor(JSON.stringify(json), { status: resp.status, statusText: resp.statusText, headers: h });
        // Response 构造器不会保留 url/type；连 clone() 也必须保留（Axios / 其他脚本可能读取）。
        const preserve = (out: Response): Response => {
          for (const key of ['url', 'type', 'redirected'] as const) Object.defineProperty(out, key, { value: resp[key], configurable: true });
          const clone = out.clone.bind(out);
          out.clone = () => preserve(clone());
          return out;
        };
        return preserve(filtered);
      }).finally(() => { if (feed) health.pendingResponses--; });
    };
    wrapped.__bfb = true;
    try {
      W.fetch = wrapped;
    } catch (e) {
      logErr('installNetworkHooks.fetch', e);
    }
  }

  installXhrHooks(W, {
    matches: isFilteredUrl,
    rewrite: rewriteRequestUrl,
    note: (url) => { health.noteRequest(url); if (isFeedUrl(url)) health.feedMatched++; },
    context: homeRequestContext,
    begin: (url) => {
      const feed = isFeedUrl(url); if (feed) health.pendingResponses++;
      return () => { if (feed) health.pendingResponses--; };
    },
    sync: (url, json, context) => discardStaleHomeFeed(json, context) ?? NET.runJson(url, json),
    async: filterResponseJson,
  });
}
