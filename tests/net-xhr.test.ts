import { describe, expect, it, vi } from 'vitest';
import { installXhrHooks } from '../src/net-xhr';

function harness() {
  class NativeXHR extends EventTarget {
    rs = 0; body = ''; responseType = ''; status = 0; url = '';
    get readyState() { return this.rs; }
    get responseText() { if (this.responseType === 'json') throw new Error('InvalidStateError'); return this.body; }
    get response() { return this.responseType === 'json' ? JSON.parse(this.body || 'null') : this.body; }
    open(_method: string, url: string) { this.url = url; this.rs = 1; this.status = 0; this.body = ''; this.dispatchEvent(new Event('readystatechange')); }
    abort() { this.rs = 0; this.status = 0; this.body = ''; }
    respond(body = '{"items":[1,2]}') {
      this.body = body; this.status = 200;
      for (const rs of [2, 3, 4]) { this.rs = rs; this.dispatchEvent(new Event('readystatechange')); }
      this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend'));
    }
  }
  const seen: string[] = [];
  let pending = 0;
  let finish!: () => void;
  const asyncFilter = vi.fn((_url: string, json: any) => new Promise<number>((resolve) => { finish = () => { json.items.pop(); resolve(1); }; }));
  installXhrHooks({ XMLHttpRequest: NativeXHR, Event }, {
    matches: (url) => url.includes('feed'), rewrite: (url) => url.replace('old', 'feed'), note: () => {},
    begin: () => { pending++; return () => { pending--; }; },
    sync: (_url, json) => { json.items.pop(); return 1; }, async: asyncFilter,
  });
  const xhr = new NativeXHR();
  return { xhr, NativeXHR, seen, asyncFilter, pending: () => pending, finish: () => finish(), listen: () => {
    for (const type of ['readystatechange', 'load', 'loadend', 'abort']) xhr.addEventListener(type, () => seen.push(type + ':' + xhr.readyState));
  } };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('XHR 渲染前异步闸门', () => {
  it('请求等待、过滤完成、原生失败、abort 与复用只结算一次', async () => {
    const h = harness(); h.xhr.open('GET', '/feed'); expect(h.pending()).toBe(1);
    h.xhr.respond(); await tick(); expect(h.pending()).toBe(1); h.finish(); await tick(); expect(h.pending()).toBe(0);
    h.xhr.open('GET', '/feed'); h.xhr.abort(); expect(h.pending()).toBe(0);
    h.xhr.open('GET', '/feed'); h.xhr.dispatchEvent(new Event('error')); expect(h.pending()).toBe(0);
    h.xhr.dispatchEvent(new Event('loadend')); expect(h.pending()).toBe(0);
    h.xhr.open('GET', '/feed'); h.xhr.open('GET', '/nav'); expect(h.pending()).toBe(0);
  });
  it('等待时不泄漏 DONE/正文，完成后按顺序投递事件且只判一次', async () => {
    const h = harness(); h.xhr.open('GET', '/feed'); h.listen(); h.xhr.respond(); await tick();
    expect(h.seen).toEqual(['readystatechange:2']); expect(h.xhr.readyState).toBe(3); expect(h.xhr.responseText).toBe('');
    h.finish(); await tick();
    expect(h.seen).toEqual(['readystatechange:2', 'readystatechange:4', 'load:4', 'loadend:4']);
    expect(JSON.parse(h.xhr.responseText).items).toEqual([1]); expect(h.xhr.response).toBe(h.xhr.responseText);
    expect(h.asyncFilter).toHaveBeenCalledTimes(1);
  });
  it('json 类型支持 .response，仍保留 responseText 的原生异常', async () => {
    const h = harness(); h.xhr.open('GET', '/feed'); h.xhr.responseType = 'json'; h.xhr.respond(); await tick();
    expect(h.xhr.response).toBeNull(); expect(() => h.xhr.responseText).toThrow('InvalidStateError');
    h.finish(); await tick(); expect(h.xhr.response).toEqual({ items: [1] });
  });
  it('实例复用为非目标接口时移除旧 getter，不串上一响应', async () => {
    const h = harness(); h.xhr.open('GET', '/feed'); h.xhr.respond(); await tick(); h.finish(); await tick();
    h.xhr.open('GET', '/nav'); h.xhr.respond('{"nav":true}'); expect(h.xhr.responseText).toBe('{"nav":true}');
    expect(h.asyncFilter).toHaveBeenCalledTimes(1);
  });
  it('过滤未结束就 open 新请求，迟到结果和旧事件必须丢弃', async () => {
    const h = harness(); h.xhr.open('GET', '/feed'); h.listen(); h.xhr.respond(); await tick();
    h.xhr.open('GET', '/nav'); h.xhr.respond('{"second":true}'); const before = [...h.seen]; h.finish(); await tick();
    expect(h.seen).toEqual(before); expect(h.xhr.responseText).toBe('{"second":true}');
  });
  it('在过滤期间 abort，回报取消而不是伪造成功', async () => {
    const h = harness(); h.xhr.open('GET', '/feed'); h.listen(); h.xhr.respond(); await tick(); h.xhr.abort();
    expect(h.seen).toEqual(['readystatechange:2', 'readystatechange:0', 'abort:0', 'loadend:0']);
    h.finish(); await tick(); expect(h.seen.filter((e) => e === 'load:4')).toHaveLength(0);
  });
  it('异步过滤拒绝旧推荐批次时投递 abort，不把旧成功或风控正文放行', async () => {
    const h = harness(); h.asyncFilter.mockImplementation(() => Promise.reject(new DOMException('stale', 'AbortError')));
    h.xhr.open('GET', '/feed'); h.listen(); h.xhr.respond(); await tick();
    expect(h.seen).toEqual(['readystatechange:2', 'readystatechange:0', 'abort:0', 'loadend:0']);
    expect(h.xhr.responseText).toBe(''); expect(h.pending()).toBe(0);
  });
  it('同步 XHR 只同步判定，不改变同步契约', () => {
    const h = harness(); (h.xhr as any).open('GET', '/feed', false); h.xhr.respond();
    expect(h.xhr.readyState).toBe(4); expect(JSON.parse(h.xhr.responseText).items).toEqual([1]); expect(h.asyncFilter).not.toHaveBeenCalled();
  });
  it('畸形 JSON 和二进制原样透传', async () => {
    const h = harness(); h.xhr.open('GET', '/feed'); h.xhr.respond('not-json'); await tick(); expect(h.xhr.responseText).toBe('not-json');
    h.xhr.open('GET', '/feed'); h.xhr.responseType = 'blob'; h.xhr.respond('binary'); expect(h.xhr.response).toBe('binary'); expect(h.asyncFilter).not.toHaveBeenCalled();
  });
  it('URL 改写仍在 open 前执行，重复安装不套娃', () => {
    const h = harness(); h.xhr.open('GET', '/old'); expect(h.xhr.url).toBe('/feed');
    const patched = h.NativeXHR.prototype.open; installXhrHooks({ XMLHttpRequest: h.NativeXHR }, {} as any); expect(h.NativeXHR.prototype.open).toBe(patched);
  });
});
