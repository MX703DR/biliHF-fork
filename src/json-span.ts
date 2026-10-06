// 对已经 JSON.parse 校验过的文本定位属性值，保留整数键的原始书写顺序。
// 不替代 JSON 解析器，不解析执行内容；扫描字符串时跳过转义，不用正则匹配嵌套 JSON。
export function jsonPropertySpan(raw: string, path: string[]): { start: number; end: number } | null {
  const space = (i: number) => { while (/\s/.test(raw[i] || '') && i < raw.length) i++; return i; };
  const stringEnd = (start: number) => {
    let i = start + 1;
    while (i < raw.length) { if (raw[i] === '\\') i += 2; else if (raw[i++] === '"') return i; }
    return raw.length;
  };
  const valueEnd = (start: number) => {
    if (raw[start] === '"') return stringEnd(start);
    let depth = 0; let i = start;
    if (raw[i] === '{' || raw[i] === '[') {
      do {
        const ch = raw[i];
        if (ch === '"') { i = stringEnd(i); continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;
        i++;
      } while (i < raw.length && depth);
    } else while (i < raw.length && !/[\s,}\]]/.test(raw[i])) i++;
    return i;
  };
  const find = (start: number, level: number): { start: number; end: number } | null => {
    if (raw[space(start)] !== '{') return null;
    let i = space(start) + 1; let result = null;
    while ((i = space(i)) < raw.length && raw[i] !== '}') {
      if (raw[i] !== '"') return null;
      const keyEnd = stringEnd(i); const key = JSON.parse(raw.slice(i, keyEnd));
      i = space(keyEnd); if (raw[i] !== ':') return null;
      const begin = space(i + 1); const end = valueEnd(begin);
      if (key === path[level]) result = level === path.length - 1 ? { start: begin, end } : find(begin, level + 1);
      i = space(end); if (raw[i] === ',') i++; else break;
    }
    return result;
  };
  return path.length ? find(0, 0) : null;
}
