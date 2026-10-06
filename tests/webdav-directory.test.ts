import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { normalizeWebDavRepositoryUrl, parseWebDavDirectory, repositoryChildUrl, repositoryRelativePath, resolveWebDavFilePath } from '../src/webdav-directory';
beforeEach(() => vi.stubGlobal('DOMParser', DOMParser));
const root = 'https://dav.example.com/dav/';
const xml = (href: string, status = 200, collection = true) => `<multistatus xmlns="DAV:"><response><href>${href}</href><propstat><prop><resourcetype>${collection ? '<collection/>' : ''}</resourcetype></prop><status>HTTP/1.1 ${status} OK</status></propstat></response></multistatus>`;
describe('WebDAV 路径边界和 XML', () => {
  it('根目录自身不会被拼接成域名根目录', () => { expect(repositoryChildUrl(root, [], true)).toBe(root); expect(parseWebDavDirectory(xml('/dav/'), root, root)[0].url).toBe(root); });
  it('支持不同 XML 前缀、相对 href 和 URL 编码', () => {
    expect(parseWebDavDirectory(xml('PiliPlus/').replaceAll('<multistatus', '<D:multistatus').replaceAll('</multistatus>', '</D:multistatus>').replace('xmlns="DAV:"', 'xmlns="DAV:" xmlns:D="DAV:"'), root, root)[0].name).toBe('PiliPlus');
    expect(parseWebDavDirectory(xml('/dav/%E6%B5%8B%E8%AF%95%20%E5%A4%87%E4%BB%BD/'), root, root)[0].name).toBe('测试 备份');
  });
  it.each(['https://evil.example/dav/PiliPlus/', '/dav2/PiliPlus/', '/dav/%2foutside/', '/dav/%5coutside/', '/outside/', '/dav/PiliPlus/nested/'])('拒绝越界 href %s', (href) => expect(parseWebDavDirectory(xml(href), root, root)).toEqual([]));
  it('忽略 404 propstat，不把失败属性认成目录', () => expect(parseWebDavDirectory(xml('/dav/PiliPlus/', 404), root, root)).toEqual([]));
  it('错误命名空间、HTML、DOCTYPE 都拒绝', () => {
    for (const text of [xml('/dav/').replace('DAV:', 'urn:evil'), '<html/>', '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]>' + xml('/dav/')]) expect(() => parseWebDavDirectory(text, root, root)).toThrow();
  });
  it('不允许仓库 URL 带凭据/查询参数或使用文件地址', () => {
    expect(() => normalizeWebDavRepositoryUrl(root + '?password=secret')).toThrow('查询参数');
    expect(repositoryRelativePath(root, 'https://user:pass@dav.example.com/dav/a.json')).toBeNull();
  });
});

describe('PiliPlus 文件路径', () => {
  it('实际旧目录名按用户输入保留，不重命名远端路径', () => {
    const folder = 'Pili' + 'Nara';
    expect(resolveWebDavFilePath(root, `/piliplus/${folder}/piliplus_settings_phone.json`)).toBe(`${root}piliplus/${folder}/piliplus_settings_phone.json`);
  });
  it.each(['/piliplus/PiliPlus', '/piliplus/PiliPlus/', 'piliplus/PiliPlus/', 'https://dav.example.com/dav/piliplus/PiliPlus/'])('目录 %s 默认手机文件', input => {
    expect(resolveWebDavFilePath(root, input)).toBe(root + 'piliplus/PiliPlus/piliplus_settings_phone.json');
  });
  it('文件名和同仓库完整 URL 都保留；中文/空格只编码一次', () => {
    expect(resolveWebDavFilePath(root, '/目录/设备设置.json')).toBe(root + '%E7%9B%AE%E5%BD%95/%E8%AE%BE%E5%A4%87%E8%AE%BE%E7%BD%AE.json');
    expect(resolveWebDavFilePath(root, root + 'a/custom_settings.json')).toBe(root + 'a/custom_settings.json');
    expect(resolveWebDavFilePath(root, '/%E6%B5%8B%E8%AF%95%20%E5%A4%87%E4%BB%BD/')).toBe(root + '%E6%B5%8B%E8%AF%95%20%E5%A4%87%E4%BB%BD/piliplus_settings_phone.json');
  });
  it('仓库根目录可以作为默认文件的目录', () => expect(resolveWebDavFilePath(root, '/')).toBe(root + 'piliplus_settings_phone.json'));
  it.each(['../out.json', '/a/./config.json', '/a/%2e%2e/out.json', '/a/%2fout.json', '/a/%5cout.json', '/a/%00out.json', '/a/%ZZ', 'file:///config.json', '//evil.example/config.json', 'https://evil.example/dav/file.json', 'https://dav.example.com/outside/file.json', 'https://user:password@dav.example.com/dav/file.json', '/file.json?password=x', '/file.json#x', '/a\\file.json'])('拒绝越界或非法路径 %s', input => expect(() => resolveWebDavFilePath(root, input)).toThrow());
});
