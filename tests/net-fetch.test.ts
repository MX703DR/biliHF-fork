import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, DEFAULT_CONFIG } from '../src/config';
import { rebuildRules } from '../src/match/engine';
import { installNetworkHooks, filterFeedJson, advanceHomeFeedEpoch } from '../src/net';
import { health } from '../src/health';
const url = 'https://api.bilibili.com/x/web-interface/popular?pn=1';
beforeEach(() => { Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG)); CONFIG.block.keywords.push('屏蔽词'); rebuildRules(); });
afterEach(() => vi.unstubAllGlobals());
const response = (body: any) => {
  const r = new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'content-length': '999', 'content-encoding': 'gzip' } });
  Object.defineProperties(r, { url: { value: url }, type: { value: 'cors' }, redirected: { value: true } });
  return r;
};
function setup(r: Response) {
  const fetch = vi.fn().mockResolvedValue(r);
  const W = { fetch, Response, Headers, DOMException };
  vi.stubGlobal('unsafeWindow', W); installNetworkHooks();
  return { W, fetch };
}
describe('fetch 响应契约', () => {
  it('下载等待 / 正常完成 / 网络错误都正确结算在途计数', async () => {
    let resolve!: (r: Response) => void;
    const W = { fetch: (_url?: unknown) => new Promise<Response>(r => { resolve = r; }), Response, Headers, DOMException };
    vi.stubGlobal('unsafeWindow', W); installNetworkHooks();
    const before = health.pendingResponses; const p = W.fetch(url);
    expect(health.pendingResponses).toBe(before + 1);
    resolve(response({ code: 0, data: { list: [] } })); await p; expect(health.pendingResponses).toBe(before);
    const broken = { fetch: (_url?: unknown) => Promise.reject(new Error('network')), Response, Headers, DOMException };
    vi.stubGlobal('unsafeWindow', broken); installNetworkHooks();
    await expect(broken.fetch(url)).rejects.toThrow('network'); expect(health.pendingResponses).toBe(before);
  });
  it('删项后正文/clone 一致，保留 url/type/redirected 并删除失效的长度和压缩头', async () => {
    const h = setup(response({ code: 0, data: { list: [{ title: '屏蔽词' }, { title: '保留' }] } }));
    const out = await h.W.fetch(url);
    expect(out.url).toBe(url); expect(out.type).toBe('cors'); expect(out.redirected).toBe(true);
    expect(out.headers.has('content-length')).toBe(false); expect(out.headers.has('content-encoding')).toBe(false);
    const copy = out.clone(); expect(copy.url).toBe(url); expect(copy.type).toBe('cors'); expect(copy.redirected).toBe(true);
    expect(await copy.json()).toEqual({ code: 0, data: { list: [{ title: '保留' }] } }); expect(await out.json()).toEqual({ code: 0, data: { list: [{ title: '保留' }] } });
  });
  it('无命中和不相干的接口返回同一个原生 Response，不改其字节/元数据', async () => {
    const r = response({ code: 0, data: { list: [{ title: '保留' }] } }); const h = setup(r);
    expect(await h.W.fetch(url)).toBe(r); expect(await h.W.fetch('https://api.bilibili.com/x/web-interface/nav')).toBe(r);
  });
  it('URL 对象和 Request 输入也能过滤，不重建 Request', async () => {
    const h = setup(response({ code: 0, data: { list: [{ title: '屏蔽词' }] } }));
    const input = new URL(url); expect((await (await h.W.fetch(input)).json()).data.list).toEqual([]); expect(h.fetch.mock.calls[0][0]).toBe(input);
    const r = response({ code: 0, data: { list: [{ title: '屏蔽词' }] } }); const h2 = setup(r); const request = new Request(url);
    expect((await (await h2.W.fetch(request)).json()).data.list).toEqual([]); expect(h2.fetch.mock.calls[0][0]).toBe(request);
  });
  it('无效 JSON 仍按原样返回，AbortSignal 取消不能被容错吞掉', async () => {
    const r = response('invalid'); const h = setup(r); expect(await h.W.fetch(url)).toBe(r);
    const controller = new AbortController(); const p = h.W.fetch(url, { signal: controller.signal }); controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('合法空列表也记为解析成功，不误报接口结构坏了', () => {
    const before = health.feedParsed; expect(filterFeedJson(url, { code: 0, data: { list: [] } })).toBe(0); expect(health.feedParsed).toBe(before + 1);
  });
  it('完整刷新之前在途的旧批次不能迟到追加回新列表', async () => {
    const h = setup(response({ code: 0, data: { item: [{ title: '旧批次' }] } }));
    const rcmd = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?fetch_row=4&w_rid=unchanged';
    const old = h.W.fetch(rcmd); advanceHomeFeedEpoch();
    expect((await (await old).json()).data.item).toEqual([]);
    const fresh = await h.W.fetch(rcmd); expect((await fresh.json()).data.item).toEqual([{ title: '旧批次' }]);
  });
});
