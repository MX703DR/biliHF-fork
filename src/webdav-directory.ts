// WebDAV 目录解析：只接受 DAV XML、同仓库的直接子项，不把凭据发给列表中的外部链接。
export interface WebDavEntry { url: string; name: string; collection: boolean }
const DAV = 'DAV:';

function httpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('WebDAV 地址格式不正确'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('WebDAV 地址必须使用 http:// 或 https://');
  if (url.username || url.password) throw new Error('请把用户名和密钥填在独立输入框，不要写进 URL');
  if (url.search) throw new Error('请填写 WebDAV 目录地址，不要包含查询参数');
  url.hash = '';
  return url;
}

export function normalizeWebDavRepositoryUrl(raw: string): string {
  if (!raw.trim()) throw new Error('请填写 WebDAV 仓库地址');
  const url = httpUrl(raw);
  if (/\.json\/?$/i.test(url.pathname)) throw new Error('请填写仓库目录地址，不是 JSON 文件地址');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export function repositoryChildUrl(root: string, names: string[], collection = false): string {
  if (names.some((x) => !x || x === '.' || x === '..' || /[/\\]/.test(x))) throw new Error('WebDAV 文件路径不正确');
  if (!names.length) return normalizeWebDavRepositoryUrl(root);
  return new URL(names.map(encodeURIComponent).join('/') + (collection ? '/' : ''), normalizeWebDavRepositoryUrl(root)).href;
}

function pathParts(url: URL): string[] | null {
  try {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    // eslint-disable-next-line no-control-regex -- WebDAV 路径安全检查，拒绝编码控制字符。
    return parts.some((x) => x === '.' || x === '..' || /[/\\\u0000-\u001f]/.test(x)) ? null : parts;
  } catch { return null; }
}

/** 允许仓库自身或下属路径；拒绝跨源、编码分隔符和路径逃逸。 */
export function repositoryRelativePath(root: string, target: string): string[] | null {
  try {
    const base = new URL(normalizeWebDavRepositoryUrl(root)); const url = httpUrl(target);
    if (base.origin !== url.origin) return null;
    const a = pathParts(base); const b = pathParts(url);
    if (!a || !b || a.some((x, i) => b[i] !== x) || b.length < a.length) return null;
    return b.slice(a.length);
  } catch { return null; }
}

function children(el: Element, localName: string): Element[] {
  return Array.from(el.childNodes).filter((x): x is Element => x.nodeType === 1 && (x as Element).namespaceURI === DAV && (x as Element).localName === localName);
}

export function parseWebDavDirectory(raw: string, root: string, directory: string): WebDavEntry[] {
  if (!raw || raw.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('WebDAV 目录响应无效或超过 2MB');
  let doc: Document;
  try { doc = new DOMParser().parseFromString(raw, 'application/xml'); } catch { throw new Error('服务器返回的不是有效 WebDAV XML'); }
  if (doc.documentElement?.localName !== 'multistatus' || doc.documentElement.namespaceURI !== DAV || doc.getElementsByTagName('parsererror').length) {
    throw new Error('服务器返回的不是 WebDAV 目录，请检查仓库地址');
  }
  const parentParts = repositoryRelativePath(root, directory);
  if (!parentParts) throw new Error('WebDAV 目录超出仓库范围');
  const found = new Map<string, WebDavEntry>();
  for (const response of Array.from(doc.getElementsByTagNameNS(DAV, 'response'))) {
    const href = children(response, 'href')[0]?.textContent?.trim();
    if (!href) continue;
    const ownStatus = children(response, 'status')[0]?.textContent || '';
    if (ownStatus && !/\s2\d\d(?:\s|$)/.test(ownStatus)) continue;
    const props = children(response, 'propstat').filter((p) => /\s2\d\d(?:\s|$)/.test(children(p, 'status')[0]?.textContent || ''));
    if (!props.length) continue;
    let url: URL;
    try { url = new URL(href, directory); } catch { continue; }
    const relative = repositoryRelativePath(root, url.href);
    if (!relative || relative.length < parentParts.length || relative.length > parentParts.length + 1 || parentParts.some((x, i) => relative[i] !== x)) continue;
    const collection = props.some((p) => p.getElementsByTagNameNS(DAV, 'collection').length > 0);
    const canonical = repositoryChildUrl(root, relative, collection);
    found.set(canonical, { url: canonical, name: relative[relative.length - 1] || '', collection });
  }
  return [...found.values()];
}
