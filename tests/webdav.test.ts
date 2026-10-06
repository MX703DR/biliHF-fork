import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';

vi.mock('../src/gm', () => ({ gmRequest: vi.fn() }));

import { gmRequest } from '../src/gm';
import {
  buildPiliNaraBackupWithMergedBlockedUsers,
  importPiliNaraBlockedUsers,
  loadWebDavSettings,
  normalizeWebDavRepositoryUrl,
  discoverPiliNaraFiles,
  downloadWebDavBackup,
  readPiliNaraBlockedUsers,
  webDavBackupUrl,
  parsePiliNaraBlockedUsers,
  parseWebDavBackup,
  saveWebDavSettings,
  testWebDavConnection,
  requestWebDavAccess,
  uploadWebDavBackup,
  webDavStatusText,
  writePiliNaraBlockedUsers,
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
const phoneUrl = 'https://dav.example.com/dav/PiliNara/piliplus_settings_phone.json';
const xml = (entries: Array<[string, boolean]>) => `<d:multistatus xmlns:d="DAV:">${entries.map(([href, folder]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${folder ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`;

const piliNaraBackup = (blocked: unknown = { '123': '甲', '456': '乙' }) =>
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
    expect(stored).toEqual({ schemaVersion: 2, url: 'https://dav.example.com/dav/', username: 'alice', password: 'secret' });
  });

  it('旧双文件地址迁移为共同仓库，保留旧备份只读恢复地址', () => {
    (globalThis as any).__gmStore[WEBDAV_SETTINGS_KEY] = JSON.stringify({ url: 'https://dav.example.com/dav/backup/old.json', piliNaraUrl: phoneUrl, username: 'alice', password: 'secret' });
    expect(loadWebDavSettings()).toEqual({ url: settings().url, legacyBackupUrl: 'https://dav.example.com/dav/backup/old.json', username: 'alice', password: 'secret' });
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

describe('PiliNara 自动目录识别', () => {
  const discovery = (names = ['phone', 'pad']) => requestMock.mockImplementation((opts: any) => {
    expect(opts.method).toBe('PROPFIND'); expect(opts.headers.Depth).toBe('1');
    const folder = opts.url.endsWith('/PiliNara/');
    opts.onload({ status: 207, responseText: xml(folder ? names.map((x) => [`/dav/PiliNara/piliplus_settings_${x}.json`, false]) : [['/dav/', true], ['/dav/PiliNara/', true], ['/dav/unrelated/', true], ['https://evil.example/dav/PiliNara/', true]]) }); return true;
  });
  it('只扫描直接 PiliNara 目录，识别手机/平板/桌面文件', async () => {
    discovery(['phone', 'pad', 'desktop']); const files = await discoverPiliNaraFiles(settings());
    expect(files.map((x) => x.device)).toEqual(['desktop', 'pad', 'phone']); expect(requestMock).toHaveBeenCalledTimes(2);
  });
  it('没有 PiliNara 不影响本插件仓库连接', async () => {
    requestMock.mockImplementation((opts: any) => { opts.onload({ status: 207, responseText: xml([['/dav/', true]]) }); return true; });
    await expect(testWebDavConnection(settings())).resolves.toEqual({ backupExists: false, piliNaraFiles: [] });
  });
  it('多设备未选择时拒绝读改写，不盲写第一份', async () => {
    discovery(); await expect(writePiliNaraBlockedUsers(settings())).rejects.toThrow('选择');
    expect(requestMock.mock.calls.every(([opts]) => opts.method === 'PROPFIND')).toBe(true);
  });
  it('单设备可以直接自动发现后读取', async () => {
    discovery(['phone']); const discoverRequest = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((opts: any) => {
      if (opts.method === 'PROPFIND') return discoverRequest(opts);
      expect(opts.url).toBe(phoneUrl); opts.onload({ status: 200, responseText: piliNaraBackup() }); return true;
    });
    await expect(readPiliNaraBlockedUsers(settings())).resolves.toMatchObject({ remoteCount: 2, added: 2 });
  });
  it('选择文件必须位于同源、同仓库的 PiliNara 目录', async () => {
    await expect(writePiliNaraBlockedUsers(settings(), 'https://evil.example/PiliNara/piliplus_settings_phone.json')).rejects.toThrow('不在当前仓库');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('PiliNara 屏蔽用户兼容', () => {
  it('已有映射的书写顺序、名字空格和未知项原样保留，较小的新 UID 只追加到末尾', () => {
    CONFIG.block.uids.push('20', '1', '10');
    const raw = '{"setting":{},"video":{},"localCache":{"recommendBlockedMids":{"20":"  原名  ","10":"乙","future":{"keep":true}}}}';
    const { body, result } = buildPiliNaraBackupWithMergedBlockedUsers(raw);
    expect(JSON.parse(body).localCache.recommendBlockedMids).toEqual({ '20': '  原名  ', '10': '乙', future: { keep: true }, '1': 'UID:1' });
    expect(body.indexOf('"20"')).toBeLessThan(body.indexOf('"10"')); expect(body.indexOf('"1"')).toBeGreaterThan(body.indexOf('"future"'));
    expect(result).toMatchObject({ written: 4, added: 1 });
  });
  it('读取当前 UID→名称格式，并兼容旧版 UID 数组', () => {
    expect(parsePiliNaraBlockedUsers(piliNaraBackup())).toEqual({ '123': '甲', '456': '乙' });
    expect(parsePiliNaraBlockedUsers(piliNaraBackup([123, '456', 'bad']))).toEqual({
      '123': 'UID:123',
      '456': 'UID:456',
    });
  });

  it('拒绝普通 JSON 和畸形 recommendBlockedMids', () => {
    expect(() => parsePiliNaraBlockedUsers('{"localCache":{}}')).toThrow('PiliNara');
    expect(() => parsePiliNaraBlockedUsers(piliNaraBackup('123'))).toThrow('recommendBlockedMids');
  });

  it('从 PiliNara 合并到本地 UID 黑名单，不删除已有规则并同步名称', () => {
    CONFIG.block.uids.push('9', '123');
    CONFIG.block.bvids.push('BV1keep');
    const result = importPiliNaraBlockedUsers(piliNaraBackup());
    expect(result).toEqual({ remoteCount: 2, added: 1, localCount: 3 });
    expect(CONFIG.block.uids).toEqual(['9', '123', '456']);
    expect(CONFIG.block.bvids).toEqual(['BV1keep']);
    expect(CONFIG.uidNames['123']).toBe('甲');
    expect(CONFIG.uidNames['456']).toBe('乙');
  });

  it('写回时保留远端用户并在末尾去重合并，其他 PiliNara 数据保持不变', () => {
    CONFIG.block.uids.push('123', '100', 'not-a-uid');
    CONFIG.block.bvids.push('BV1unsupported');
    CONFIG.uidNames['100'] = '本地名称';
    const updated = buildPiliNaraBackupWithMergedBlockedUsers(piliNaraBackup());
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
        opts.onload({ status: 200, responseText: piliNaraBackup(), responseHeaders: 'ETag: "v7"\r\n' });
      } else {
        expect(opts.method).toBe('PUT');
        expect(opts.headers['If-Match']).toBe('"v7"');
        expect(JSON.parse(opts.data).localCache.blackMids).toEqual([999]);
        opts.onload({ status: 204, responseText: '', responseHeaders: '' });
      }
      return true;
    });
    await expect(
      writePiliNaraBlockedUsers(settings(), phoneUrl)
    ).resolves.toEqual({ written: 3, added: 1, skippedInvalidUids: 0 });
    expect(calls).toBe(2);
  });
  it('没有新增 UID 时只读，不无意义 PUT 整份配置', async () => {
    CONFIG.block.uids.push('123');
    requestMock.mockImplementation((opts: any) => { expect(opts.method).toBe('GET'); opts.onload({ status: 200, responseText: piliNaraBackup() }); return true; });
    await expect(writePiliNaraBlockedUsers(settings(), phoneUrl)).resolves.toMatchObject({ added: 0 }); expect(requestMock).toHaveBeenCalledTimes(1);
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
