// 只保存页面已经给出的匹配字段，不补拉接口、不保存 Cookie / 凭据 / 播放进度 / 完整响应。
import { METADATA_KEY } from './constants';
import type { CardInfo } from './cardinfo';

interface Entry { at: number; data: any }
const MAX = 1800;
const TTL = 7 * 86400000;
const entries = new Map<string, Entry>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const text = (x: unknown) => typeof x === 'string' ? x.slice(0, 2000) : '';
const number = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;

function thin(key: string, data: any): any {
  if (!data || typeof data !== 'object') return null;
  if (key.startsWith('t:')) return Array.isArray(data) ? data.filter((x) => typeof x === 'string').slice(0, 100).map(text) : null;
  if (key.startsWith('c:')) {
    const c = data.card || data;
    return { card: { mid: String(c.mid || ''), name: text(c.name), sign: text(c.sign) } };
  }
  if (!key.startsWith('v:')) return null;
  return {
    owner: { mid: String(data.owner?.mid || ''), name: text(data.owner?.name) },
    tname: text(data.tname), duration: number(data.duration),
    stat: { view: number(data.stat?.view), like: number(data.stat?.like) },
    is_upower_exclusive: typeof data.is_upower_exclusive === 'boolean' || data.is_upower_exclusive === 0 || data.is_upower_exclusive === 1 ? !!data.is_upower_exclusive : undefined,
  };
}

function readStored(): Map<string, Entry> {
  const out = new Map<string, Entry>();
  try {
    const raw = GM_getValue(METADATA_KEY, '');
    if (typeof raw !== 'string' || raw.length > 2500000) return out;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return out;
    for (const row of list.slice(0, MAX)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 100) continue;
      const [key, entry] = row;
      if (!entry || !Number.isFinite(entry.at) || entry.at > Date.now() || Date.now() - entry.at > TTL) continue;
      const data = thin(key, entry.data);
      if (data) out.set(key, { at: entry.at, data });
    }
  } catch { /* 损坏缓存不影响用户规则 */ }
  return out;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  for (const [key, value] of readStored()) entries.set(key, value);
}

export function cachedMetadata(bvid: string, uid = ''): { view: any; tags: string[] | null; card: any } {
  load();
  const get = (key: string) => {
    const e = entries.get(key);
    if (!e || Date.now() - e.at > (key.startsWith('c:') ? 86400000 : TTL)) return null;
    return e.data;
  };
  const view = bvid ? get('v:' + bvid) : null;
  return { view, tags: bvid ? get('t:' + bvid) : null, card: uid || view?.owner?.mid ? get('c:' + (uid || view.owner.mid)) : null };
}

function put(key: string, value: any): void {
  load();
  let data = thin(key, value);
  if (!data) return;
  const old = entries.get(key);
  // 推荐流只提供部分字段，不能用缺失字段覆盖此前页面详情给出的分区/充电标记。
  if (key.startsWith('v:') && old && Date.now() - old.at < TTL) {
    data = { ...old.data, ...Object.fromEntries(Object.entries(data).filter(([, x]) => x !== undefined && x !== '')),
      owner: { mid: data.owner.mid || old.data.owner.mid, name: data.owner.name || old.data.owner.name },
      stat: { ...old.data.stat, ...Object.fromEntries(Object.entries(data.stat).filter(([, x]) => x !== undefined)) } };
    if (!data.tname) data.tname = old.data.tname;
  }
  if (old && JSON.stringify(old.data) === JSON.stringify(data) && Date.now() - old.at < 3600000) return;
  entries.delete(key);
  entries.set(key, { at: Date.now(), data });
  while (entries.size > MAX) entries.delete(entries.keys().next().value!);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const merged = readStored();
    for (const [k, e] of entries) if (!merged.has(k) || merged.get(k)!.at <= e.at) merged.set(k, e);
    const rows = [...merged].filter(([, e]) => Date.now() - e.at <= TTL).sort((a, b) => b[1].at - a[1].at).slice(0, MAX);
    try { GM_setValue(METADATA_KEY, JSON.stringify(rows)); } catch { /* 缓存可丢，配置不可丢 */ }
  }, 2000);
}

export function rememberFeedMetadata(info: CardInfo): void {
  if (!info.bvid || info.isDynamic) return;
  put('v:' + info.bvid, { owner: { mid: info.uid, name: info.up }, tname: info.partition,
    duration: info.duration, stat: { view: info.views, like: info.likes } });
}
export function rememberMetadata(kind: 'v' | 't' | 'c', id: string, data: any): void {
  if (id && id.length <= 80) put(kind + ':' + id, data);
}
export const isMetadataUrl = (url: string): boolean => /\/x\/web-interface\/(?:wbi\/)?(?:view(?:\/detail(?:\/tag)?)?|card)(?:\?|$)/.test(url);

export function observeMetadata(url: string, json: any): void {
  if (json?.code !== 0 || !json.data) return;
  try {
    const u = new URL(url, 'https://api.bilibili.com');
    if (u.hostname !== 'api.bilibili.com' || !isMetadataUrl(u.href)) return;
    const d = json.data;
    if (/\/card$/.test(u.pathname)) rememberMetadata('c', String(d.card?.mid || u.searchParams.get('mid') || ''), d);
    else if (/\/tag$/.test(u.pathname)) rememberMetadata('t', u.searchParams.get('bvid') || '', Array.isArray(d) ? d.map((x) => x.tag_name) : null);
    else {
      const v = d.View || d; const bvid = v.bvid || u.searchParams.get('bvid') || '';
      rememberMetadata('v', bvid, v);
      if (Array.isArray(d.Tags)) rememberMetadata('t', bvid, d.Tags.map((x: any) => x.tag_name));
      if (d.Card) rememberMetadata('c', String(d.Card.card?.mid || v.owner?.mid || ''), d.Card);
    }
  } catch { /* 非标准响应不参与缓存 */ }
}

export function observeInitialMetadata(state: any): void {
  const v = state?.videoData;
  if (!v?.bvid) return;
  rememberMetadata('v', v.bvid, v);
  if (Array.isArray(state.tags)) rememberMetadata('t', v.bvid, state.tags.map((x: any) => x.tag_name));
  if (state.upData) rememberMetadata('c', String(state.upData.mid || v.owner?.mid || ''), state.upData);
}
