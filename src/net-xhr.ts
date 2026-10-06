// XHR 的异步响应闸门。拦住 DONE/load/loadend，过滤完成后按原顺序交还事件。
// 页面不能在标签/详情仍在途时从 responseText 或 response 读到未过滤的正文。
export interface XhrFilters {
  matches: (url: string) => boolean;
  rewrite: (url: string) => string;
  note: (url: string) => void;
  context?: (url: string) => unknown;
  begin?: (url: string) => () => void;
  sync: (url: string, json: any, context?: unknown) => number;
  async: (url: string, json: any, context?: unknown) => Promise<number>;
}

export function installXhrHooks(W: any, filters: XhrFilters): void {
  const proto = W.XMLHttpRequest?.prototype;
  if (!proto || proto.__bfb) return;
  const open = proto.open;
  const abort = proto.abort;
  const text = Object.getOwnPropertyDescriptor(proto, 'responseText')?.get;
  const response = Object.getOwnPropertyDescriptor(proto, 'response')?.get;
  const state = Object.getOwnPropertyDescriptor(proto, 'readyState')?.get;
  if (!text || !response || !state) return;
  const active = new WeakMap<object, { cleanup: () => void; cancel: () => boolean }>();

  proto.open = function (this: XMLHttpRequest, method: string, url: string, async = true, user?: string | null, password?: string | null) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 异步闸门与属性 getter 必须引用原始 XHR 实例
    const xhr = this;
    active.get(xhr)?.cleanup();
    active.delete(xhr);
    const target = typeof url === 'string' ? filters.rewrite(url) : String(url);
    filters.note(target);
    if (!filters.matches(target)) return open.call(xhr, method, target, async, user, password);
    const context = filters.context?.(target);
    const endPending = filters.begin?.(target);
    let pending = true;
    const settled = () => { if (pending) { pending = false; endPending?.(); } };

    let closed = false;
    let gating = false;
    let complete = false;
    let replay = false;
    let parsed = false;
    let json: any;
    let raw: any;
    let result: any;
    let resultText: string | undefined;
    const events: Event[] = [];
    const rawState = () => state.call(xhr) as number;
    const canFilter = () => xhr.responseType === '' || xhr.responseType === 'text' || xhr.responseType === 'json';
    const parse = () => {
      if (parsed) return;
      parsed = true;
      raw = response.call(xhr);
      if (xhr.responseType === 'json') json = raw;
      else if (typeof raw === 'string' && raw) {
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON 透传 */ }
      }
    };
    const commit = (changed: number) => {
      if (xhr.responseType === 'json') result = json ?? raw;
      else {
        resultText = changed ? JSON.stringify(json) : raw;
        result = resultText;
      }
      complete = true;
      settled();
    };
    const syncRead = () => {
      if (complete) return;
      parse();
      let changed = 0;
      try { if (json) changed = filters.sync(target, json, context); } catch (e) { /* 故障放行 */ }
      commit(changed);
    };
    Object.defineProperties(xhr, {
      readyState: { configurable: true, get: () => gating ? 3 : rawState() },
      responseText: {
        configurable: true,
        get: () => {
          // 非 text 类型保留原生 InvalidStateError，不把它变成一个空字符串。
          if (xhr.responseType !== '' && xhr.responseType !== 'text') return text.call(xhr);
          if (gating || (async && rawState() === 3)) return '';
          if (rawState() !== 4 || !canFilter()) return text.call(xhr);
          syncRead();
          return resultText;
        },
      },
      response: {
        configurable: true,
        get: () => {
          if (gating || (async && rawState() === 3 && canFilter())) return xhr.responseType === 'json' ? null : '';
          if (rawState() !== 4 || !canFilter()) return response.call(xhr);
          syncRead();
          return result;
        },
      },
    });

    const makeEvent = (event: Event): Event => {
      if (W.ProgressEvent && 'loaded' in event) {
        const p = event as ProgressEvent;
        return new W.ProgressEvent(event.type, { lengthComputable: p.lengthComputable, loaded: p.loaded, total: p.total });
      }
      return new (W.Event || Event)(event.type);
    };
    const flush = () => {
      if (closed) return;
      gating = false;
      replay = true;
      try {
        for (const event of events) {
          if (closed) break; // onload 中复用 open/abort 后，不能再投递上一请求的 loadend。
          xhr.dispatchEvent(makeEvent(event));
        }
      } finally {
        replay = false;
        events.length = 0;
      }
    };
    const capture = (event: Event) => {
      if (closed || replay || complete || !async || !canFilter() || xhr.status === 0) return;
      const rs = rawState();
      // LOADING 的正文也不能泄漏：这些接口是一次性 JSON，不是流式消费者。
      if (rs === 3 && (event.type === 'readystatechange' || event.type === 'progress')) {
        event.stopImmediatePropagation();
        return;
      }
      if (rs !== 4) return;
      event.stopImmediatePropagation();
      events.push(event);
      if (gating) return;
      gating = true;
      parse();
      Promise.resolve().then(() => json ? filters.async(target, json, context) : 0).then(
        (changed) => { if (!closed) { commit(changed); flush(); } },
        () => { if (!closed) { commit(0); flush(); } },
      );
    };
    const types = ['readystatechange', 'progress', 'load', 'loadend'];
    for (const type of types) xhr.addEventListener(type, capture, true);
    const finishedNative = () => { if (!gating) settled(); };
    for (const type of ['loadend', 'error', 'abort', 'timeout']) xhr.addEventListener(type, finishedNative, true);
    const cleanup = () => {
      closed = true;
      settled();
      events.length = 0;
      for (const type of types) xhr.removeEventListener(type, capture, true);
      for (const type of ['loadend', 'error', 'abort', 'timeout']) xhr.removeEventListener(type, finishedNative, true);
      for (const prop of ['readyState', 'responseText', 'response']) Reflect.deleteProperty(xhr, prop);
    };
    active.set(xhr, {
      cleanup,
      cancel: () => { const wasGating = gating; cleanup(); return wasGating; },
    });
    try { return open.call(xhr, method, target, async, user, password); }
    catch (e) { cleanup(); active.delete(xhr); throw e; }
  };
  proto.abort = function (this: XMLHttpRequest) {
    const cancelled = active.get(this)?.cancel();
    active.delete(this);
    const value = abort.call(this);
    // 底层已 DONE 而脚本仍在等标签时，原生 abort 不会发事件；补回消费者所期待的取消通知。
    if (cancelled) {
      for (const type of ['readystatechange', 'abort', 'loadend']) this.dispatchEvent(new (W.Event || Event)(type));
    }
    return value;
  };
  proto.__bfb = true;
}
