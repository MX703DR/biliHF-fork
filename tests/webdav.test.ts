import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';

vi.mock('../src/gm', () => ({ gmRequest: vi.fn() }));

import { gmRequest } from '../src/gm';
import {
  buildPiliPlusBackupWithMergedBlockedUsers,
  importPiliPlusBlockedUsers,
  loadWebDavSettings,
  normalizeWebDavRepositoryUrl,
  discoverPiliPlusFiles,
  downloadWebDavBackup,
  readPiliPlusBlockedUsers,
  webDavBackupUrl,
  parsePiliPlusBlockedUsers,
  parseWebDavBackup,
  saveWebDavSettings,
  testWebDavConnection,
  testPiliPlusConnection,
  piliPlusConnection,
  EMPTY_PILIPLUS,
  requestWebDavAccess,
  uploadWebDavBackup,
  webDavStatusText,
  writePiliPlusBlockedUsers,
} from '../src/webdav';
import { WEBDAV_SETTINGS_KEY } from '../src/constants';
import { CONFIG, DEFAULT_CONFIG } from '../src/config';

const requestMock = vi.mocked(gmRequest);

beforeEach(() => {
  vi.stubGlobal('DOMParser', DOMParser);
  requestMock.mockReset();
  (globalThis as any).__gmClear();
  Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG));
});

const settings = () => ({
  url: 'https://dav.example.com/dav/',
  username: '用户',
  password: 'secret',
});
const phoneUrl = 'https://dav.example.com/dav/PiliPlus/piliplus_settings_phone.json';
const xml = (entries: Array<[string, boolean]>) => `<d:multistatus xmlns:d="DAV:">${entries.map(([href, folder]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${folder ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`;

const piliPlusBackup = (blocked: unknown = { '123': '甲', '456': '乙' }) =>
  JSON.stringify({
    setting: { themeMode: 2, untouched: { nested: true } },
    video: { playSpeedDefault: 1.5 },
    localCache: {
      blackMids: [999],
      dynamicsBlockedMids: [888],
      replyBlockedMids: { '777': '评论用户' },
      recommendBlockedMids: blocked,
    },
  });

describe('WebDAV 地址与凭据', () => {
  it('只接受 http(s) 仓库目录，自动补斜杠', () => {
    expect(normalizeWebDavRepositoryUrl(' https://dav.example.com/dav#x ')).toBe('https://dav.example.com/dav/');
    expect(normalizeWebDavRepositoryUrl('https://dav.example.com')).toBe('https://dav.example.com/');
    expect(() => normalizeWebDavRepositoryUrl('ftp://dav.example.com/dav')).toThrow('http://');
    expect(() => normalizeWebDavRepositoryUrl('https://dav.example.com/a.json')).toThrow('目录地址');
    expect(() => normalizeWebDavRepositoryUrl('https://user:pass@dav.example.com/dav/')).toThrow('独立输入框');
  });

  it('凭据只写入独立 GM 存储', () => {
    saveWebDavSettings({ url: 'https://dav.example.com/dav', username: 'alice', password: 'secret' });
    const stored = JSON.parse((globalThis as any).__gmStore[WEBDAV_SETTINGS_KEY]);
    expect(stored).toEqual({ schemaVersion: 3, url: 'https://dav.example.com/dav/', username: 'alice', password: 'secret' });
  });

  it('旧双文件地址迁移为共同仓库，保留旧备份只读恢复地址', () => {
    (globalThis as any).__gmStore[WEBDAV_SETTINGS_KEY] = JSON.stringify({ url: 'https://dav.example.com/dav/backup/old.json', piliPlusUrl: phoneUrl, username: 'alice', password: 'secret' });
    expect(loadWebDavSettings()).toEqual({ url: settings().url, legacyBackupUrl: 'https://dav.example.com/dav/backup/old.json', username: 'alice', password: 'secret', piliPlus: { ...EMPTY_PILIPLUS, path: 'PiliPlus/piliplus_settings_phone.json' } });
    const saved = saveWebDavSettings({ ...settings(), username: 'alice' });
    expect(saved.legacyBackupUrl).toContain('old.json');
    expect(saveWebDavSettings({ ...settings(), url: 'https://other.example/dav/' })).not.toHaveProperty('legacyBackupUrl');
  });

  it('只有旧备份地址时以其父目录为仓库', () => {
    (globalThis as any).__gmStore[WEBDAV_SETTINGS_KEY] = JSON.stringify({
      url: 'https://dav.example.com/a.json',
      username: 'alice',
      password: 'secret',
    });
    expect(loadWebDavSettings().url).toBe('https://dav.example.com/');
    expect(loadWebDavSettings().legacyBackupUrl).toBe('https://dav.example.com/a.json');
  });
});

describe('PiliPlus 自定义路径与独立登录', () => {
  const explicit = () => ({ ...settings(), piliPlus: { ...EMPTY_PILIPLUS, path: '/piliplus/legacy-folder/piliplus_settings_phone.json' } });
  const independent = () => ({ ...explicit(), piliPlus: { ...explicit().piliPlus, separate: true, url: 'https://other.example/store/', username: 'pili-user', password: 'pili-key' } });
  const auth = (opts: any) => new TextDecoder().decode(Uint8Array.from(atob(opts.headers.Authorization.slice(6)), x => x.charCodeAt(0)));

  it('旧版本存储键无损迁移，保留实际云端目录名', () => {
    const oldKey = 'pili' + 'NaraUrl'; // 只为兼容旧版存档，不恢复旧 UI 名称。
    (globalThis as any).__gmStore[WEBDAV_SETTINGS_KEY] = JSON.stringify({ url: settings().url + 'backup/old.json', [oldKey]: settings().url + 'legacy-folder/piliplus_settings_phone.json', username: 'old-user', password: 'old-key' });
    expect(loadWebDavSettings()).toMatchObject({ url: settings().url, username: 'old-user', password: 'old-key', piliPlus: { path: 'legacy-folder/piliplus_settings_phone.json', separate: false } });
  });

  it('版本 2 三字段设置仍然可以加载并共用', () => {
    (globalThis as any).__gmStore[WEBDAV_SETTINGS_KEY] = JSON.stringify({ schemaVersion: 2, ...settings() });
    expect(loadWebDavSettings()).toEqual(settings());
    expect(piliPlusConnection(loadWebDavSettings())).toEqual(settings());
  });

  it('关闭独立登录时忽略隐藏的地址和凭据', () => {
    const s = independent(); s.piliPlus.separate = false;
    expect(piliPlusConnection(s)).toEqual(settings());
  });

  it('开启独立登录时仅使用独立服务，不回退本插件凭据', () => {
    expect(piliPlusConnection(independent())).toEqual({ url: 'https://other.example/store/', username: 'pili-user', password: 'pili-key' });
    const s = independent(); s.piliPlus.username = ''; s.piliPlus.password = '';
    expect(piliPlusConnection(s)).toMatchObject({ username: '', password: '' });
    s.piliPlus.url = '';
    expect(() => piliPlusConnection(s)).toThrow('仓库地址');
  });

  it('路径与两套凭据只存在专用本机存储，普通备份不含它们', async () => {
    const s = saveWebDavSettings(independent());
    expect(loadWebDavSettings()).toEqual(s);
    requestMock.mockImplementation((opts: any) => {
      expect(opts.url).toContain(settings().url); expect(auth(opts)).toBe('用户:secret');
      if (opts.method === 'PUT') for (const secret of ['pili-user', 'pili-key', 'other.example', 'legacy-folder', 'secret']) expect(opts.data).not.toContain(secret);
      opts.onload({ status: 201, responseText: '' }); return true;
    });
    await uploadWebDavBackup(s);
  });

  it('保存自身凭据时保留已保存的 PiliPlus 设置，但不保留跨仓库旧备份', () => {
    saveWebDavSettings(independent());
    expect(saveWebDavSettings(settings()).piliPlus).toEqual(independent().piliPlus);
  });

  it('显式文件和目录路径不需要 PROPFIND 自动扫描', async () => {
    await expect(discoverPiliPlusFiles(explicit())).resolves.toEqual([{ url: settings().url + 'piliplus/legacy-folder/piliplus_settings_phone.json', name: 'piliplus_settings_phone.json', device: 'phone' }]);
    const s = explicit(); s.piliPlus.path = '/piliplus/legacy-folder';
    expect((await discoverPiliPlusFiles(s))[0].url).toBe(settings().url + 'piliplus/legacy-folder/piliplus_settings_phone.json');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('任意自定义 JSON 文件名原样使用', async () => {
    const s = explicit(); s.piliPlus.path = 'nested/custom-settings.json';
    expect((await discoverPiliPlusFiles(s))[0]).toEqual({ url: settings().url + 'nested/custom-settings.json', name: 'custom-settings.json', device: 'custom' });
  });

  it('共享服务的自定义深层路径直接 GET，不扫描其他文件夹', async () => {
    requestMock.mockImplementation((opts: any) => {
      expect(opts.method).toBe('GET'); expect(opts.url).toBe(settings().url + 'piliplus/legacy-folder/piliplus_settings_phone.json'); expect(auth(opts)).toBe('用户:secret');
      opts.onload({ status: 200, responseText: piliPlusBackup() }); return true;
    });
    await expect(readPiliPlusBlockedUsers(explicit())).resolves.toMatchObject({ added: 2 });
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it('独立服务 GET→ETag PUT 只发送独立凭据并保留其他配置', async () => {
    CONFIG.block.uids.push('100');
    requestMock.mockImplementation((opts: any) => {
      expect(opts.url).toBe('https://other.example/store/piliplus/legacy-folder/piliplus_settings_phone.json'); expect(auth(opts)).toBe('pili-user:pili-key');
      if (opts.method === 'GET') opts.onload({ status: 200, responseText: piliPlusBackup(), responseHeaders: 'ETag: "independent-v1"' });
      else {
        expect(opts.method).toBe('PUT'); expect(opts.headers['If-Match']).toBe('"independent-v1"');
        expect(JSON.parse(opts.data).setting).toEqual({ themeMode: 2, untouched: { nested: true } });
        opts.onload({ status: 204, responseText: '' });
      }
      return true;
    });
    await expect(writePiliPlusBlockedUsers(independent())).resolves.toMatchObject({ added: 1, written: 3 });
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('只读测试先向独立服务无凭据探测，然后认证读取实际文件', async () => {
    const calls: string[] = [];
    requestMock.mockImplementation((opts: any) => {
      calls.push(opts.method);
      if (opts.method === 'PROPFIND') {
        expect(opts.url).toBe('https://other.example/store/'); expect(opts.headers.Depth).toBe('0'); expect(opts.headers.Authorization).toBeUndefined();
        opts.onload({ status: 401, responseText: '' });
      } else {
        expect(opts.method).toBe('GET'); expect(auth(opts)).toBe('pili-user:pili-key'); opts.onload({ status: 200, responseText: piliPlusBackup() });
      }
      return true;
    });
    await expect(testPiliPlusConnection(independent())).resolves.toMatchObject({ remoteCount: 2 });
    expect(calls).toEqual(['PROPFIND', 'GET']); expect(CONFIG.block.uids).toEqual([]);
  });

  it('独立域名探测失败不发送密钥', async () => {
    requestMock.mockImplementation((opts: any) => { expect(opts.headers.Authorization).toBeUndefined(); opts.onerror(); return true; });
    await expect(testPiliPlusConnection(independent())).rejects.toThrow('允许访问 other.example');
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it('独立 PiliPlus 不可用也不影响自身备份连接测试', async () => {
    requestMock.mockImplementation((opts: any) => {
      expect(opts.url).toBe(settings().url); opts.onload({ status: 207, responseText: xml([['/dav/', true]]) }); return true;
    });
    await expect(testWebDavConnection(independent())).resolves.toMatchObject({ backupExists: false });
  });

  it('选中文件必须与显式路径相同，越界或旧选择不带凭据访问', async () => {
    for (const target of ['https://other.example/store/x.json', phoneUrl, settings().url + 'piliplus/legacy-folder/other.json']) {
      await expect(writePiliPlusBlockedUsers(explicit(), target)).rejects.toThrow('不在当前仓库');
    }
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('非法路径和空独立地址在保存时拒绝，原设置不变', () => {
    const s = saveWebDavSettings(settings());
    const bad = explicit(); bad.piliPlus.path = '../outside.json';
    expect(() => saveWebDavSettings(bad)).toThrow('越出仓库'); expect(loadWebDavSettings()).toEqual(s);
    const empty = independent(); empty.piliPlus.url = '';
    expect(() => saveWebDavSettings(empty)).toThrow('仓库地址'); expect(loadWebDavSettings()).toEqual(s);
  });
});

describe('WebDAV 网络请求', () => {
  it('通用域名授权探测只读自身，不携带凭据，401 不误判为认证失败', async () => {
    requestMock.mockImplementation((opts: any) => {
      expect(opts.method).toBe('PROPFIND'); expect(opts.headers.Depth).toBe('0'); expect(opts.url).toBe(settings().url);
      expect(opts.headers.Authorization).toBeUndefined(); expect(opts.anonymous).toBe(true); expect(opts.redirect).toBe('error');
      opts.onload({ status: 401, responseText: '' }); return true;
    });
    await expect(requestWebDavAccess(settings())).resolves.toBeUndefined(); expect(requestMock).toHaveBeenCalledOnce();
  });
  it('探测被管理器拒绝时，报告实际域名且不进入带凭据的目录请求', async () => {
    requestMock.mockImplementation((opts: any) => { opts.onerror(); return true; });
    await expect(testWebDavConnection(settings())).rejects.toThrow('允许访问 dav.example.com'); expect(requestMock).toHaveBeenCalledOnce();
  });
  it('MKCOL 自动建文件夹，然后 PUT 配置；凭据不进入备份', async () => {
    const methods: string[] = [];
    requestMock.mockImplementation((opts: any) => {
      methods.push(opts.method);
      expect(new TextDecoder().decode(Uint8Array.from(atob(opts.headers.Authorization.slice(6)), (x) => x.charCodeAt(0)))).toBe('用户:secret');
      if (opts.method === 'MKCOL') { expect(opts.url).toBe('https://dav.example.com/dav/biliHoyoFairy-MX703/'); opts.onload({ status: 201, responseText: '' }); return true; }
      expect(opts.url).toBe(webDavBackupUrl(settings()));
      const body = JSON.parse(opts.data);
      expect(body.app).toBe('biliHoyoFairy-MX703');
      expect(JSON.stringify(body)).not.toContain('secret');
      opts.onload({ status: 201, responseText: '' });
      return true;
    });

    await expect(
      uploadWebDavBackup(settings())
    ).resolves.toBeUndefined();
    expect(methods).toEqual(['MKCOL', 'PUT']);
  });

  it('把常见状态码转换为可操作提示', () => {
    expect(webDavStatusText(401)).toContain('用户名或密钥');
    expect(webDavStatusText(409)).toContain('仓库父目录');
    expect(webDavStatusText(412)).toContain('其他设备修改');
    expect(webDavStatusText(507)).toContain('空间不足');
  });

  it('连接测试验证目录 XML，不把任意 404 误报为连接成功', async () => {
    requestMock.mockImplementation((opts: any) => {
      opts.onload({ status: 404, responseText: '' });
      return true;
    });
    await expect(testWebDavConnection(settings())).rejects.toThrow('不存在');
  });
  it('备份目录已存在时确认它真的是文件夹再上传', async () => {
    const methods: string[] = [];
    requestMock.mockImplementation((opts: any) => {
      methods.push(opts.method);
      opts.onload({ status: opts.method === 'MKCOL' ? 405 : opts.method === 'PROPFIND' ? 207 : 204, responseText: opts.method === 'PROPFIND' ? xml([['/dav/biliHoyoFairy-MX703/', true]]) : '' }); return true;
    });
    await uploadWebDavBackup(settings()); expect(methods).toEqual(['MKCOL', 'PROPFIND', 'PUT']);
  });
  it('MKCOL 405 并且同名是文件时不继续写入', async () => {
    requestMock.mockImplementation((opts: any) => { expect(opts.method).not.toBe('PUT'); opts.onload({ status: opts.method === 'MKCOL' ? 405 : 207, responseText: xml([['/dav/biliHoyoFairy-MX703', false]]) }); return true; });
    await expect(uploadWebDavBackup(settings())).rejects.toThrow('不是文件夹');
  });
  it('新备份不存在时可只读恢复同仓库旧备份', async () => {
    requestMock.mockImplementation((opts: any) => { expect(opts.method).toBe('GET'); opts.onload({ status: opts.url.endsWith('old.json') ? 200 : 404, responseText: opts.url.endsWith('old.json') ? 'old backup' : '' }); return true; });
    await expect(downloadWebDavBackup({ ...settings(), legacyBackupUrl: settings().url + 'old.json' })).resolves.toBe('old backup');
  });
});

describe('PiliPlus 自动目录识别', () => {
  const discovery = (names = ['phone', 'pad']) => requestMock.mockImplementation((opts: any) => {
    expect(opts.method).toBe('PROPFIND'); expect(opts.headers.Depth).toBe('1');
    const folder = opts.url.endsWith('/PiliPlus/');
    opts.onload({ status: 207, responseText: xml(folder ? names.map((x) => [`/dav/PiliPlus/piliplus_settings_${x}.json`, false]) : [['/dav/', true], ['/dav/PiliPlus/', true], ['/dav/unrelated/', true], ['https://evil.example/dav/PiliPlus/', true]]) }); return true;
  });
  it('只扫描直接 PiliPlus 目录，识别手机/平板/桌面文件', async () => {
    discovery(['phone', 'pad', 'desktop']); const files = await discoverPiliPlusFiles(settings());
    expect(files.map((x) => x.device)).toEqual(['desktop', 'pad', 'phone']); expect(requestMock).toHaveBeenCalledTimes(2);
  });
  it('没有 PiliPlus 不影响本插件仓库连接', async () => {
    requestMock.mockImplementation((opts: any) => { opts.onload({ status: 207, responseText: xml([['/dav/', true]]) }); return true; });
    await expect(testWebDavConnection(settings())).resolves.toEqual({ backupExists: false, piliPlusFiles: [] });
  });
  it('多设备未选择时拒绝读改写，不盲写第一份', async () => {
    discovery(); await expect(writePiliPlusBlockedUsers(settings())).rejects.toThrow('选择');
    expect(requestMock.mock.calls.every(([opts]) => opts.method === 'PROPFIND')).toBe(true);
  });
  it('单设备可以直接自动发现后读取', async () => {
    discovery(['phone']); const discoverRequest = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((opts: any) => {
      if (opts.method === 'PROPFIND') return discoverRequest(opts);
      expect(opts.url).toBe(phoneUrl); opts.onload({ status: 200, responseText: piliPlusBackup() }); return true;
    });
    await expect(readPiliPlusBlockedUsers(settings())).resolves.toMatchObject({ remoteCount: 2, added: 2 });
  });
  it('选择文件必须位于同源、同仓库的 PiliPlus 目录', async () => {
    await expect(writePiliPlusBlockedUsers(settings(), 'https://evil.example/PiliPlus/piliplus_settings_phone.json')).rejects.toThrow('不在当前仓库');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('PiliPlus 屏蔽用户兼容', () => {
  it('兼容 Hive 实际导出的小写 localcache，并且不另造 camelCase 目录或字段', () => {
    const raw = piliPlusBackup().replace('"localCache"', '"localcache"');
    expect(parsePiliPlusBlockedUsers(raw)).toEqual({ '123': '甲', '456': '乙' });
    CONFIG.block.uids.push('100');
    const { body } = buildPiliPlusBackupWithMergedBlockedUsers(raw);
    expect(JSON.parse(body).localcache.recommendBlockedMids['100']).toBe('UID:100');
    expect(body).not.toContain('"localCache"');
  });
  it('只改小写黑名单对应的片段，其他设置的空格、大整数与字符串原样保留', () => {
    const raw = '{ "setting" : { "large" : 12345678901234567890123 }, "video":{}, "localcache" : {"blackMids":[999],"recommendBlockedMids":{"20":"  原名  "}}, "future":{"keep": true} }';
    CONFIG.block.uids.push('1'); const { body } = buildPiliPlusBackupWithMergedBlockedUsers(raw);
    expect(body.startsWith('{ "setting" : { "large" : 12345678901234567890123 }, "video":{}, "localcache" : {"blackMids":[999],"recommendBlockedMids":')).toBe(true);
    expect(body.endsWith('}, "future":{"keep": true} }')).toBe(true);
    expect(body).toContain('"20":"  原名  "'); expect(body.indexOf('"1"')).toBeGreaterThan(body.indexOf('"20"'));
  });
  it('两种 cache 键同时存在时，以 Hive 原生小写为准，另一份不动', () => {
    const raw = '{"setting":{},"video":{},"localcache":{"recommendBlockedMids":{"20":"原生"}},"localCache":{"recommendBlockedMids":{"99":"未知旧字段"}}}';
    expect(parsePiliPlusBlockedUsers(raw)).toEqual({ '20': '原生' });
    CONFIG.block.uids.push('1'); const { body } = buildPiliPlusBackupWithMergedBlockedUsers(raw);
    expect(body).toContain('"localCache":{"recommendBlockedMids":{"99":"未知旧字段"}}');
    expect(JSON.parse(body).localcache.recommendBlockedMids['1']).toBe('UID:1');
  });
  it.each(['{}', '{"blackMids":[999]}'])('缓存 %s 尚无推荐名单时只插入目标字段', cache => {
    const raw = '{ "setting":{}, "video":{}, "localcache":' + cache + ', "untouched":12345678901234567890123 }';
    CONFIG.block.uids.push('1'); const { body } = buildPiliPlusBackupWithMergedBlockedUsers(raw);
    expect(JSON.parse(body).localcache.recommendBlockedMids).toEqual({ '1': 'UID:1' });
    expect(body).toContain('"untouched":12345678901234567890123');
    if (cache.includes('blackMids')) expect(body).toContain('"blackMids":[999]');
  });
  it('旧客户端未导出任何缓存时拒绝写入，提供重新备份提示', () => {
    CONFIG.block.uids.push('1');
    expect(() => buildPiliPlusBackupWithMergedBlockedUsers('{"setting":{},"video":{}}')).toThrow('重新备份');
  });
  it('已有映射的书写顺序、名字空格和未知项原样保留，较小的新 UID 只追加到末尾', () => {
    CONFIG.block.uids.push('20', '1', '10');
    const raw = '{"setting":{},"video":{},"localCache":{"recommendBlockedMids":{"20":"  原名  ","10":"乙","future":{"keep":true}}}}';
    const { body, result } = buildPiliPlusBackupWithMergedBlockedUsers(raw);
    expect(JSON.parse(body).localCache.recommendBlockedMids).toEqual({ '20': '  原名  ', '10': '乙', future: { keep: true }, '1': 'UID:1' });
    expect(body.indexOf('"20"')).toBeLessThan(body.indexOf('"10"')); expect(body.indexOf('"1"')).toBeGreaterThan(body.indexOf('"future"'));
    expect(result).toMatchObject({ written: 4, added: 1 });
  });
  it('读取当前 UID→名称格式，并兼容旧版 UID 数组', () => {
    expect(parsePiliPlusBlockedUsers(piliPlusBackup())).toEqual({ '123': '甲', '456': '乙' });
    expect(parsePiliPlusBlockedUsers(piliPlusBackup([123, '456', 'bad']))).toEqual({
      '123': 'UID:123',
      '456': 'UID:456',
    });
  });

  it('拒绝普通 JSON 和畸形 recommendBlockedMids', () => {
    expect(() => parsePiliPlusBlockedUsers('{"localCache":{}}')).toThrow('PiliPlus');
    expect(() => parsePiliPlusBlockedUsers(piliPlusBackup('123'))).toThrow('recommendBlockedMids');
  });

  it('从 PiliPlus 合并到本地 UID 黑名单，不删除已有规则并同步名称', () => {
    CONFIG.block.uids.push('9', '123');
    CONFIG.block.bvids.push('BV1keep');
    const result = importPiliPlusBlockedUsers(piliPlusBackup());
    expect(result).toEqual({ remoteCount: 2, added: 1, localCount: 3 });
    expect(CONFIG.block.uids).toEqual(['9', '123', '456']);
    expect(CONFIG.block.bvids).toEqual(['BV1keep']);
    expect(CONFIG.uidNames['123']).toBe('甲');
    expect(CONFIG.uidNames['456']).toBe('乙');
  });

  it('写回时保留远端用户并在末尾去重合并，其他 PiliPlus 数据保持不变', () => {
    CONFIG.block.uids.push('123', '100', 'not-a-uid');
    CONFIG.block.bvids.push('BV1unsupported');
    CONFIG.uidNames['100'] = '本地名称';
    const updated = buildPiliPlusBackupWithMergedBlockedUsers(piliPlusBackup());
    const doc = JSON.parse(updated.body);
    expect(updated.result).toEqual({ written: 3, added: 1, skippedInvalidUids: 1 });
    expect(doc.localCache.recommendBlockedMids).toEqual({ '100': '本地名称', '123': '甲', '456': '乙' });
    expect(updated.body.indexOf('"100"')).toBeGreaterThan(updated.body.indexOf('"456"')); // 数字更小也必须追加在末尾
    expect(doc.localCache.blackMids).toEqual([999]);
    expect(doc.localCache.dynamicsBlockedMids).toEqual([888]);
    expect(doc.localCache.replyBlockedMids).toEqual({ '777': '评论用户' });
    expect(doc.setting).toEqual({ themeMode: 2, untouched: { nested: true } });
    expect(doc.video).toEqual({ playSpeedDefault: 1.5 });
    expect(updated.body).not.toContain('BV1unsupported');
  });

  it('远端写入采用 GET→PUT，服务器有 ETag 时使用 If-Match 防并发覆盖', async () => {
    CONFIG.block.uids.push('123', '100');
    let calls = 0;
    requestMock.mockImplementation((opts: any) => {
      calls++;
      expect(opts.url).toBe(phoneUrl);
      if (opts.method === 'GET') {
        opts.onload({ status: 200, responseText: piliPlusBackup(), responseHeaders: 'ETag: "v7"\r\n' });
      } else {
        expect(opts.method).toBe('PUT');
        expect(opts.headers['If-Match']).toBe('"v7"');
        expect(JSON.parse(opts.data).localCache.blackMids).toEqual([999]);
        opts.onload({ status: 204, responseText: '', responseHeaders: '' });
      }
      return true;
    });
    await expect(
      writePiliPlusBlockedUsers(settings(), phoneUrl)
    ).resolves.toEqual({ written: 3, added: 1, skippedInvalidUids: 0 });
    expect(calls).toBe(2);
  });
  it('没有新增 UID 时只读，不无意义 PUT 整份配置', async () => {
    CONFIG.block.uids.push('123');
    requestMock.mockImplementation((opts: any) => { expect(opts.method).toBe('GET'); opts.onload({ status: 200, responseText: piliPlusBackup() }); return true; });
    await expect(writePiliPlusBlockedUsers(settings(), phoneUrl)).resolves.toMatchObject({ added: 0 }); expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe('WebDAV 远端备份清洗', () => {
  it('拒绝伪装文件，并剔除订阅等不可移植字段', () => {
    expect(() => parseWebDavBackup('{"app":"other","config":{}}')).toThrow('不是 biliHoyoFairy-MX703');
    const parsed = parseWebDavBackup(
      JSON.stringify({
        app: 'biliHoyoFairy',
        config: {
          block: { keywords: ['保留', 1] },
          allow: { keywords: [], upNames: [], uids: [] },
          subscriptions: [{ url: 'https://evil.example/rules.json', name: 'x', enabled: true }],
          debug: true,
          allowMetadataRequests: true,
        },
      })
    );
    expect(parsed.block.keywords).toEqual(['保留']);
    expect(parsed).not.toHaveProperty('subscriptions');
    expect(parsed).not.toHaveProperty('debug');
    expect(parsed).not.toHaveProperty('allowMetadataRequests');
  });
});
