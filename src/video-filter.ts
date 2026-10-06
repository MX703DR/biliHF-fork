// 渲染前的统一视频判定：网络响应、首屏状态和 DOM 兜底共用。
// 默认纯本地立即判定；仅明确授权的联网批次最多等 8 秒，迟到结果不重排已显示内容。
import type { CardInfo } from './cardinfo';
import { CONFIG } from './config';
import { fetchView, fetchTags, fetchCard, riskGuard } from './api';
import { M, apiNeeds, isWhitelisted, matchApi, matchRule, ruleVersion } from './match/engine';
import { capMapSet } from './util';
import { cachedMetadata, rememberFeedMetadata } from './metadata-cache';

export const FILTER_WAIT_MS = 8000;
interface Metadata { view: any; tags: string[] | null; card: any }
export interface VideoVerdict { reason: string | null; info: CardInfo; version: number; deferred?: boolean }
const verdicts = new Map<string, VideoVerdict>();
const latestVerdicts = new Map<string, VideoVerdict>();
const pending = new Map<string, Promise<VideoVerdict>>();
const verdictKey = (bvid: string, title: string, uid: string) => JSON.stringify([bvid, title, uid]);

export function dataVerdict(bvid: string, title?: string, uid?: string): VideoVerdict | null {
  const exact = bvid && title !== undefined && uid !== undefined ? verdicts.get(verdictKey(bvid, title, uid)) : null;
  const v = exact || (bvid && latestVerdicts.get(bvid));
  return v && v.version === ruleVersion && (title === undefined || v.info.title === title) && (!uid || v.info.uid === uid) ? v : null;
}

function remember(v: VideoVerdict): VideoVerdict {
  if (v.version !== ruleVersion) return v;
  if (v.info.bvid) {
    capMapSet(verdicts, verdictKey(v.info.bvid, v.info.title, v.info.uid), v, 2000);
    capMapSet(latestVerdicts, v.info.bvid, v, 2000);
  }
  return v;
}

// 只补当前规则实际缺少的字段。推荐响应已有点赞/UID 时不为这些维度逐视频请求详情。
export function videoNeeds(info: CardInfo): ReturnType<typeof apiNeeds> {
  if (!CONFIG.apiFilters || !info.bvid || isWhitelisted(info)) return { needView: false, needTag: false, needCard: false };
  const n = apiNeeds();
  const b = CONFIG.block;
  const missingPart = !info.partition && (!M.blockPartition.empty || !M.blockKw.part.empty || !M.allowKw.part.empty);
  const missingUid = !info.uid && M.needUid;
  const missingDuration = info.duration == null && (b.minDuration > 0 || b.maxDuration > 0);
  const missingViews = info.views == null && (b.minViews > 0 || b.maxViews > 0 || b.spamLikeRatio > 0);
  const missingLikes = info.likes == null && (b.minLikes > 0 || b.maxLikes > 0 || b.spamLikeRatio > 0);
  n.needView = CONFIG.hideCharging || missingPart || missingUid || missingDuration || missingViews || missingLikes || (n.needCard && !info.uid);
  return n;
}

export function needsVideoMetadata(info: CardInfo): boolean {
  const n = videoNeeds(info);
  return n.needView || n.needTag || n.needCard;
}

function enrich(info: CardInfo, view: any): CardInfo {
  if (!view) return info;
  return {
    ...info,
    uid: info.uid || (!info.isDynamic && view.owner?.mid != null ? String(view.owner.mid) : ''),
    up: info.up || (!info.isDynamic && view.owner?.name) || '',
    partition: info.partition || view.tname || '',
    duration: info.duration ?? (typeof view.duration === 'number' ? view.duration : null),
    views: info.views ?? (typeof view.stat?.view === 'number' ? view.stat.view : null),
    likes: info.likes ?? (typeof view.stat?.like === 'number' ? view.stat.like : null),
  };
}

function decide(info: CardInfo, meta?: Metadata): VideoVerdict {
  const complete = enrich(info, meta?.view);
  return {
    info: complete,
    version: ruleVersion,
    reason: !CONFIG.enabled ? null : matchRule(complete) || (CONFIG.apiFilters && meta ? matchApi(complete, meta.view, meta.tags, meta.card) : null),
  };
}

function missingMetadata(info: CardInfo, meta: Metadata): ReturnType<typeof apiNeeds> {
  const complete = enrich(info, meta.view);
  const n = videoNeeds(complete); const b = CONFIG.block;
  n.needView = n.needView && (
    (!complete.partition && (!M.blockPartition.empty || !M.blockKw.part.empty || !M.allowKw.part.empty)) ||
    (!complete.uid && (M.needUid || n.needCard)) || (complete.duration == null && (b.minDuration > 0 || b.maxDuration > 0)) ||
    (complete.views == null && (b.minViews > 0 || b.maxViews > 0 || b.spamLikeRatio > 0)) ||
    (complete.likes == null && (b.minLikes > 0 || b.maxLikes > 0 || b.spamLikeRatio > 0)) ||
    (CONFIG.hideCharging && meta.view?.is_upower_exclusive === undefined));
  n.needTag = n.needTag && meta.tags === null;
  n.needCard = n.needCard && !meta.card;
  return n;
}

// 可同步判定的先短路。缺 UID 且设了 UID 白名单时，须先取 UID，不能提前按标题误删白名单视频。
export function immediateVerdict(info: CardInfo): VideoVerdict | null {
  rememberFeedMetadata(info);
  const meta = cachedMetadata(info.bvid, info.uid);
  const complete = CONFIG.apiFilters ? enrich(info, meta.view) : info;
  if (!CONFIG.enabled || isWhitelisted(complete)) return decide(complete);
  const uncertainAllow = CONFIG.apiFilters && info.bvid && ((!complete.uid && M.allowUidSet.size > 0) || (!complete.partition && !M.allowKw.part.empty));
  const v = decide(complete, CONFIG.apiFilters ? meta : undefined);
  // 默认纯本地：缺失元数据放行，绝不留空等待，也不在迟到缓存出现后重新隐藏已显示内容。
  if (!CONFIG.allowMetadataRequests) return { ...v, reason: uncertainAllow ? null : v.reason, deferred: !!uncertainAllow || needsVideoMetadata(complete) };
  if (uncertainAllow) return null;
  const n = missingMetadata(complete, meta);
  if (v.reason || (!n.needView && !n.needTag && !n.needCard)) return v;
  return null;
}

/** 在数据层发布之前求值；deadline 由整个批次共享，避免每个接口各等 8 秒。 */
export function evaluateVideo(info: CardInfo, deadline = Date.now() + FILTER_WAIT_MS, freshResponse = false): Promise<VideoVerdict> {
  const cached = dataVerdict(info.bvid, info.title, info.uid);
  if (cached && (!freshResponse || !cached.deferred)) return Promise.resolve(cached);
  const immediate = immediateVerdict(info);
  if (immediate) return Promise.resolve(remember(immediate));
  if (riskGuard.blocked() || deadline <= Date.now()) return Promise.resolve(remember({ ...decide(info), deferred: true }));
  const key = verdictKey(info.bvid, info.title, info.uid) + ':' + ruleVersion;
  const existing = pending.get(key);
  if (existing) return existing;
  const version = ruleVersion;
  const meta: Metadata = cachedMetadata(info.bvid, info.uid);
  const n = missingMetadata(info, meta);
  const work = async () => {
    const jobs: Promise<void>[] = [];
    if (n.needView) jobs.push(new Promise<void>((resolve) => fetchView(info.bvid, (v) => { meta.view = v || meta.view; resolve(); }, deadline)));
    if (n.needTag && meta.tags === null) jobs.push(new Promise<void>((resolve) => fetchTags(info.bvid, (t) => { meta.tags = t; resolve(); }, deadline)));
    if (n.needCard && !meta.card && info.uid) jobs.push(new Promise<void>((resolve) => fetchCard(info.uid, (c) => { meta.card = c; resolve(); }, deadline)));
    await Promise.all(jobs);
    if (n.needCard && !info.uid && meta.view?.owner?.mid && Date.now() < deadline) {
      await new Promise<void>((resolve) => fetchCard(String(meta.view.owner.mid), (c) => { meta.card = c; resolve(); }, deadline));
    }
    const missing = missingMetadata(info, meta);
    return { ...decide(info, meta), deferred: missing.needTag || missing.needView || missing.needCard };
  };
  const promise = new Promise<VideoVerdict>((resolve) => {
    let settled = false;
    const finish = (v: VideoVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 取数时配置可能变化；旧请求的部分元数据不能伪装成新规则版本的完整结论。
      resolve(remember({ ...v, version }));
    };
    const timer = setTimeout(() => finish({ ...decide(info), deferred: true }), Math.max(0, deadline - Date.now()));
    work().then(finish, () => finish({ ...decide(info), deferred: true }));
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
