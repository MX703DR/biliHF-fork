// 评论隐藏模式在响应数据中删项；折叠/审查模式保留原文，以支持手动展开，交给绘制前扫描。
import { CONFIG } from './config';
import { matchComment, readCmtData, resolveReplyTarget } from './comments';
import { recordBlock } from './stats';
import { capMapSet } from './util';

export const isCommentUrl = (url: string): boolean => /\/x\/v2\/reply\/(?:wbi\/main|main|reply)(?:[?]|$)/.test(url);
const authors = new Map<string, string>();

export function filterCommentJson(url: string, json: any): number {
  if (!isCommentUrl(url) || json?.code !== 0 || !json.data || !CONFIG.enabled || !CONFIG.comment.enabled || CONFIG.reviewMode || CONFIG.comment.collapse) return 0;
  const data = json.data;
  const scope = (() => { try { const q = new URL(url, 'https://api.bilibili.com').searchParams; return (q.get('type') || '') + ':' + (q.get('oid') || ''); } catch (e) { return ''; } })();
  const context = { upMid: data.upper?.mid, me: data.current_user?.uname };
  const list: any[][] = [];
  const pinnedItems = new Set<object>();
  const visit = (arr: any, pinned = false) => {
    if (!Array.isArray(arr)) return;
    list.push(arr);
    for (const d of arr) {
      if (!d || typeof d !== 'object') continue;
      if (pinned) pinnedItems.add(d);
      if (d.rpid != null && d.member?.uname) capMapSet(authors, scope + ':' + d.rpid, String(d.member.uname).trim(), 3000);
      visit(d.replies);
    }
  };
  visit(data.replies);
  visit(data.hots);
  visit(data.top_replies, true); // 现行客户端实际渲染这一份；top.upper 常是另一份重复对象。
  // 置顶通常是单独的 top.upper / top.admin / top.vote 对象，保持它们的白名单语义。
  const topSlots: Array<{ key: string; list: any[] }> = [];
  for (const [key, d] of Object.entries(data.top || {})) {
    if (d && typeof d === 'object') { const arr = [d]; topSlots.push({ key, list: arr }); visit(arr, true); }
  }
  const replyAuthors = new Map<string, string>();
  for (const [key, name] of authors) if (key.startsWith(scope + ':')) replyAuthors.set(key.slice(scope.length + 1), name);
  let removed = 0;
  const recorded = new Set<string>();
  const selfMid = typeof document !== 'undefined' ? document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/)?.[1] : '';
  const seen = new Set<any[]>();
  for (const arr of list) {
    if (seen.has(arr)) continue;
    seen.add(arr);
    for (let i = arr.length - 1; i >= 0; i--) {
      const d = arr[i];
      if (!d || typeof d !== 'object') continue;
      const c = readCmtData(d, context);
      if (pinnedItems.has(d)) c.isUpTop = true; // 只补判定上下文，不改 B站原始 reply_control。
      const isSub = !!c.parentId && String(c.parentId) !== '0';
      c.replyToUname = resolveReplyTarget(c, replyAuthors);
      // 回复接口可能缺视频 UP 上下文；不能把「保护 UP」关闭掉来追求提前删除。
      if (CONFIG.comment.allowUp && context.upMid == null) continue;
      // 登录用户信息未提供时，把自己/提到自己的评论留给组件的 __user 判定。
      if (CONFIG.comment.allowMe && !context.me && selfMid && (String(c.mid) === selfMid || c.members.some((m) => String(m.mid) === selfMid) || c.message.includes('@'))) continue;
      const reason = matchComment(c, isSub);
      if (!reason) continue;
      arr.splice(i, 1);
      removed++;
      const id = String(c.rpid || c.uname + ':' + c.message);
      if (!recorded.has(id)) {
        recorded.add(id);
        recordBlock(reason, { up: c.uname, title: c.message.slice(0, 40) }, 'CMT');
      }
    }
  }
  for (const slot of topSlots) if (!slot.list.length) data.top[slot.key] = null;
  // 不动 cursor/page/count/rcount：分页和「更多回复」由 B站自己的原始计数控制。
  return removed;
}
