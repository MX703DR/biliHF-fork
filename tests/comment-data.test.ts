import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, DEFAULT_CONFIG } from '../src/config';
import { rebuildRules } from '../src/match/engine';
import { filterCommentJson, isCommentUrl } from '../src/comment-data';
import { blockedLog } from '../src/stats';
const url = 'https://api.bilibili.com/x/v2/reply/wbi/main?oid=123';
const reply = (rpid: number, name: string, parent = 0, message = '普通评论') => ({ rpid, mid: rpid, parent, member: { uname: name }, content: { message }, replies: [] as any[] });
beforeEach(() => { Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG)); CONFIG.comment.enabled = true; CONFIG.comment.collapse = false; CONFIG.comment.allowMe = false; rebuildRules(); });
describe('评论响应的数据层隐藏', () => {
  it('仅匹配评论主列表和楼中楼接口', () => {
    expect(isCommentUrl(url)).toBe(true); expect(isCommentUrl('https://api.bilibili.com/x/v2/reply/reply?oid=123')).toBe(true);
    expect(isCommentUrl('https://api.bilibili.com/x/v2/reply/add')).toBe(false);
  });
  it('父评论先索引再删除，直接回复被屏蔽用户的子评论也能判断', () => {
    CONFIG.comment.userNames.push('坏人'); CONFIG.comment.hideRepliesToBlockedUsers = true; rebuildRules();
    const a = reply(1, '坏人'); const b = reply(2, '普通人'); b.replies.push(reply(3, '回复者', 1));
    const json = { code: 0, data: { replies: [a, b], upper: { mid: 999 }, cursor: { next: 20 }, count: 3 } };
    expect(filterCommentJson(url, json)).toBe(2); expect(json.data.replies).toEqual([b]); expect(b.replies).toHaveLength(0);
    expect(json.data.count).toBe(3); expect(json.data.cursor.next).toBe(20);
  });
  it('跨页 parent rpid 仍能找到作者；不会污染另一视频', () => {
    CONFIG.comment.userNames.push('坏人'); CONFIG.comment.hideRepliesToBlockedUsers = true; rebuildRules();
    filterCommentJson(url, { code: 0, data: { replies: [reply(20, '坏人')], upper: { mid: 999 } } });
    const json = { code: 0, data: { replies: [reply(21, '回复者', 20)], upper: { mid: 999 } } };
    expect(filterCommentJson(url, structuredClone(json))).toBe(1);
    expect(filterCommentJson(url.replace('oid=123', 'oid=other'), json)).toBe(0);
  });
  it('UP/置顶白名单保留，缺 UP 上下文时不误删', () => {
    CONFIG.comment.userNames.push('UP'); rebuildRules();
    const c = reply(999, 'UP'); expect(filterCommentJson(url, { code: 0, data: { upper: { mid: 999 }, replies: [c] } })).toBe(0);
    expect(filterCommentJson(url, { code: 0, data: { replies: [reply(30, 'UP')] } })).toBe(0);
  });
  it('折叠模式保留原文和回复结构，以便手动展开', () => {
    CONFIG.comment.collapse = true; CONFIG.comment.userNames.push('坏人'); rebuildRules();
    const json = { code: 0, data: { replies: [reply(31, '坏人')], upper: { mid: 999 } } }; const before = structuredClone(json);
    expect(filterCommentJson(url, json)).toBe(0); expect(json).toEqual(before);
  });
  it('top_replies 和 top.upper 都过滤子回复，重复副本只记一次屏蔽', () => {
    CONFIG.comment.keywords.push('屏蔽词'); rebuildRules();
    const top = reply(40, 'UP'); top.replies.push(reply(41, '子回复作者', 40, '屏蔽词'));
    const json = { code: 0, data: { top_replies: [structuredClone(top)], top: { upper: top }, upper: { mid: 40 } } };
    const before = blockedLog.length;
    expect(filterCommentJson(url, json)).toBe(2); expect(json.data.top_replies[0].replies).toHaveLength(0); expect(json.data.top.upper.replies).toHaveLength(0);
    expect(blockedLog.length - before).toBe(1);
  });
  it('关闭置顶保护后可以删 top 的单对象，而不是只删临时数组', () => {
    CONFIG.comment.allowPin = false; CONFIG.comment.allowUp = false; CONFIG.comment.userNames.push('坏人'); rebuildRules();
    const json = { code: 0, data: { top: { admin: reply(42, '坏人') } } };
    expect(filterCommentJson(url, json)).toBe(1); expect(json.data.top.admin).toBeNull();
  });
  it('只补置顶判定的上下文，不伪造或改写响应的 reply_control', () => {
    CONFIG.comment.allowUp = false; CONFIG.comment.userNames.push('坏人'); rebuildRules();
    const json = { code: 0, data: { top_replies: [reply(43, '坏人')], top: { admin: reply(44, '坏人') } } };
    const before = structuredClone(json);
    expect(filterCommentJson(url, json)).toBe(0); expect(json).toEqual(before);
  });
  it('审查/暂停/错误响应不删评论', () => {
    CONFIG.reviewMode = true; CONFIG.comment.userNames.push('坏人'); rebuildRules();
    const json = { code: 0, data: { replies: [reply(32, '坏人')], upper: { mid: 999 } } };
    expect(filterCommentJson(url, json)).toBe(0); CONFIG.reviewMode = false; CONFIG.enabled = false; expect(filterCommentJson(url, json)).toBe(0);
  });
});
