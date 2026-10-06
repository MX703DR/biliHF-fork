import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { normalizeWebDavRepositoryUrl, parseWebDavDirectory, repositoryChildUrl, repositoryRelativePath } from '../src/webdav-directory';
beforeEach(() => vi.stubGlobal('DOMParser', DOMParser));
const root = 'https://dav.example.com/dav/';
const xml = (href: string, status = 200, collection = true) => `<multistatus xmlns="DAV:"><response><href>${href}</href><propstat><prop><resourcetype>${collection ? '<collection/>' : ''}</resourcetype></prop><status>HTTP/1.1 ${status} OK</status></propstat></response></multistatus>`;
describe('WebDAV 路径边界和 XML', () => {
  it('根目录自身不会被拼接成域名根目录', () => { expect(repositoryChildUrl(root, [], true)).toBe(root); expect(parseWebDavDirectory(xml('/dav/'), root, root)[0].url).toBe(root); });
  it('支持不同 XML 前缀、相对 href 和 URL 编码', () => {
    expect(parseWebDavDirectory(xml('PiliNara/').replaceAll('<multistatus', '<D:multistatus').replaceAll('</multistatus>', '</D:multistatus>').replace('xmlns="DAV:"', 'xmlns="DAV:" xmlns:D="DAV:"'), root, root)[0].name).toBe('PiliNara');
    expect(parseWebDavDirectory(xml('/dav/%E6%B5%8B%E8%AF%95%20%E5%A4%87%E4%BB%BD/'), root, root)[0].name).toBe('测试 备份');
  });
  it.each(['https://evil.example/dav/PiliNara/', '/dav2/PiliNara/', '/dav/%2foutside/', '/dav/%5coutside/', '/outside/', '/dav/PiliNara/nested/'])('拒绝越界 href %s', (href) => expect(parseWebDavDirectory(xml(href), root, root)).toEqual([]));
  it('忽略 404 propstat，不把失败属性认成目录', () => expect(parseWebDavDirectory(xml('/dav/PiliNara/', 404), root, root)).toEqual([]));
  it('错误命名空间、HTML、DOCTYPE 都拒绝', () => {
    for (const text of [xml('/dav/').replace('DAV:', 'urn:evil'), '<html/>', '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]>' + xml('/dav/')]) expect(() => parseWebDavDirectory(text, root, root)).toThrow();
  });
  it('不允许仓库 URL 带凭据/查询参数或使用文件地址', () => {
    expect(() => normalizeWebDavRepositoryUrl(root + '?password=secret')).toThrow('查询参数');
    expect(repositoryRelativePath(root, 'https://user:pass@dav.example.com/dav/a.json')).toBeNull();
  });
});
