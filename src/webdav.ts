// WebDAV 配置备份：凭据与插件配置分开存储，上传内容复用安全的 portable config 导出格式。
import { APP_NAME, WEBDAV_SETTINGS_KEY } from './constants';
import {
  CONFIG,
  NON_PORTABLE,
  deepMerge,
  exportConfig,
  migrateConfig,
  sanitizeConfigInput,
  saveConfig,
  setUidName,
} from './config';
import { gmRequest } from './gm';
import { jsonPropertySpan } from './json-span';
import { normalizeWebDavRepositoryUrl, parseWebDavDirectory, repositoryChildUrl, repositoryRelativePath } from './webdav-directory';
export { normalizeWebDavRepositoryUrl } from './webdav-directory';

export interface WebDavSettings {
  url: string;
  username: string;
  password: string;
  legacyBackupUrl?: string; // 旧文件只作恢复兜底；不会再向它写入。
}

const EMPTY_SETTINGS: WebDavSettings = { url: '', username: '', password: '' };
export const WEBDAV_BACKUP_MAX = 2 * 1024 * 1024;
const REQUEST_TIMEOUT = 30_000;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function legacyRepository(parsed: any): string {
  const backup = str(parsed.url, 4096); const pili = str(parsed.piliNaraUrl, 4096);
  if (pili) {
    const url = new URL(pili);
    const at = url.pathname.toLowerCase().lastIndexOf('/pilinara/');
    if (at >= 0) {
      url.pathname = url.pathname.slice(0, at + 1); url.hash = '';
      const root = normalizeWebDavRepositoryUrl(url.href);
      if (!backup || repositoryRelativePath(root, backup)) return root;
    }
  }
  return backup ? normalizeWebDavRepositoryUrl(/\.json(?:[#?]|$)/i.test(backup) ? new URL('.', backup).href : backup) : '';
}

export function loadWebDavSettings(): WebDavSettings {
  try {
    const raw = GM_getValue(WEBDAV_SETTINGS_KEY, null);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_SETTINGS };
    const url = parsed.schemaVersion === 2 ? (parsed.url ? normalizeWebDavRepositoryUrl(str(parsed.url, 4096)) : '') : legacyRepository(parsed);
    const oldFile = str(parsed.schemaVersion === 2 ? parsed.legacyBackupUrl : parsed.url, 4096);
    return {
      url,
      ...(oldFile && /\.json(?:[#?]|$)/i.test(oldFile) && repositoryRelativePath(url, oldFile) ? { legacyBackupUrl: oldFile } : {}),
      username: str(parsed.username, 512),
      password: str(parsed.password, 1024),
    };
  } catch {
    return { ...EMPTY_SETTINGS };
  }
}

export function saveWebDavSettings(input: WebDavSettings): WebDavSettings {
  const settings = {
    url: input.url.trim() ? normalizeWebDavRepositoryUrl(input.url) : '',
    username: str(input.username, 512),
    password: str(input.password, 1024),
  };
  const oldFile = input.legacyBackupUrl || loadWebDavSettings().legacyBackupUrl;
  const saved = { ...settings, ...(oldFile && repositoryRelativePath(settings.url, oldFile) ? { legacyBackupUrl: oldFile } : {}) };
  GM_setValue(WEBDAV_SETTINGS_KEY, JSON.stringify({ schemaVersion: 2, ...saved }));
  return saved;
}

function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return 'Basic ' + btoa(binary);
}

interface WebDavResponse {
  status: number;
  body: string;
  responseHeaders: string;
}

function webDavRequest(
  settings: WebDavSettings,
  url: string,
  method: 'GET' | 'PUT' | 'PROPFIND' | 'MKCOL',
  data?: string,
  acceptedStatuses: number[] = [],
  extraHeaders: Record<string, string> = {}
): Promise<WebDavResponse> {
  return new Promise((resolve, reject) => {
    if (!repositoryRelativePath(settings.url, url)) return reject(new Error('WebDAV 目标超出仓库范围'));
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    if (method === 'PUT') headers['Content-Type'] = 'application/json; charset=utf-8';
    if (method === 'PROPFIND') headers['Content-Type'] = 'application/xml; charset=utf-8';
    if (settings.username || settings.password) headers.Authorization = basicAuth(settings.username, settings.password);
    const sent = gmRequest<string>({
      method,
      url,
      headers,
      data,
      timeout: REQUEST_TIMEOUT,
      anonymous: true,
      redirect: 'error', // 不向仓库重定向出的未知地址发送凭据。
      onload: (r) => {
        if ((r.responseText || '').length > WEBDAV_BACKUP_MAX) return reject(new Error('WebDAV 响应超过 2MB，已拒绝读取'));
        if ((r.status >= 200 && r.status < 300) || acceptedStatuses.includes(r.status)) {
          resolve({ status: r.status, body: r.responseText || '', responseHeaders: r.responseHeaders || '' });
        }
        else reject(new Error(webDavStatusText(r.status)));
      },
      onerror: () => reject(new Error(`网络连接失败，请先在脚本管理器中允许访问 ${new URL(url).hostname}，再检查地址、证书和 WebDAV 服务状态`)),
      ontimeout: () => reject(new Error('连接超时，请稍后重试')),
    });
    if (!sent) reject(new Error('当前脚本管理器不支持 WebDAV 网络请求'));
  });
}

export function webDavStatusText(status: number): string {
  if (status === 401) return '认证失败，请检查用户名或密钥';
  if (status === 403) return '服务器拒绝访问，请检查文件权限';
  if (status === 404) return '远端备份文件不存在';
  if (status === 405) return '服务器不支持所需 WebDAV 操作，请检查仓库地址和目录权限';
  if (status === 409) return '仓库父目录不存在，请检查 WebDAV 仓库地址';
  if (status === 413) return '备份文件超过服务器允许的大小';
  if (status === 412) return '远端文件刚被其他设备修改，请重新读取后再同步';
  if (status === 507) return 'WebDAV 存储空间不足';
  return `WebDAV 请求失败（HTTP ${status || '未知'}）`;
}

export async function uploadWebDavBackup(settings: WebDavSettings): Promise<void> {
  const body = exportConfig();
  if (body.length > WEBDAV_BACKUP_MAX) throw new Error('备份内容过大（超过 2MB）');
  const directory = webDavBackupDirectory(settings);
  const created = await webDavRequest(settings, directory, 'MKCOL', undefined, [405]);
  if (created.status === 405) {
    // 405 也可能是“不支持 MKCOL”，不能直接认定目录存在后盲目 PUT。
    const existing = await listWebDavDirectory(settings, directory, '0');
    if (!existing.some((x) => x.url === directory && x.collection)) throw new Error('无法创建备份目录，或同名路径不是文件夹');
  }
  await webDavRequest(settings, webDavBackupUrl(settings), 'PUT', body);
}

export async function downloadWebDavBackup(settings: WebDavSettings): Promise<string> {
  const response = await webDavRequest(settings, webDavBackupUrl(settings), 'GET', undefined, [404]);
  if (response.status === 404 && !settings.legacyBackupUrl) throw new Error('远端尚无配置备份，请先点击“立即备份”');
  const raw = response.status === 404
    ? (await webDavRequest(settings, settings.legacyBackupUrl!, 'GET')).body : response.body;
  if (raw.length > WEBDAV_BACKUP_MAX) throw new Error('远端备份过大（超过 2MB），已拒绝读取');
  return raw;
}

export function webDavBackupDirectory(settings: WebDavSettings): string { return repositoryChildUrl(settings.url, [APP_NAME], true); }
export function webDavBackupUrl(settings: WebDavSettings): string { return repositoryChildUrl(settings.url, [APP_NAME, 'config.json']); }
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
async function listWebDavDirectory(settings: WebDavSettings, directory: string, depth = '1') {
  const response = await webDavRequest(settings, directory, 'PROPFIND', PROPFIND_BODY, [], { Depth: depth });
  return parseWebDavDirectory(response.body, settings.url, directory);
}
export interface PiliNaraFile { url: string; name: string; device: string }
async function piliNaraFilesIn(settings: WebDavSettings, entries: Awaited<ReturnType<typeof listWebDavDirectory>>): Promise<PiliNaraFile[]> {
  const folders = entries.filter((x) => x.collection && x.name.toLowerCase() === 'pilinara' && repositoryRelativePath(settings.url, x.url)?.length === 1);
  const lists = await Promise.all(folders.map((x) => listWebDavDirectory(settings, x.url)));
  return lists.flat().filter((x) => !x.collection && /^piliplus_settings_(phone|pad|desktop)\.json$/i.test(x.name))
    .map((x) => ({ url: x.url, name: x.name, device: x.name.match(/_(phone|pad|desktop)\.json$/i)![1].toLowerCase() })).sort((a, b) => a.name.localeCompare(b.name));
}
export async function discoverPiliNaraFiles(settings: WebDavSettings): Promise<PiliNaraFile[]> {
  return piliNaraFilesIn(settings, await listWebDavDirectory(settings, normalizeWebDavRepositoryUrl(settings.url)));
}
/** 首次访问由管理器处理域名授权；探测不携带用户名/密钥，只读仓库自身，不创建文件。 */
export async function requestWebDavAccess(settings: WebDavSettings): Promise<void> {
  const root = normalizeWebDavRepositoryUrl(settings.url);
  await webDavRequest({ url: root, username: '', password: '' }, root, 'PROPFIND', PROPFIND_BODY, [401, 403], { Depth: '0' });
}
/** 只读连接测试；备份时才创建本插件的目录，不写 PiliNara。 */
export async function testWebDavConnection(settings: WebDavSettings): Promise<{ backupExists: boolean; piliNaraFiles: PiliNaraFile[] }> {
  const root = normalizeWebDavRepositoryUrl(settings.url);
  await requestWebDavAccess(settings);
  const entries = await listWebDavDirectory(settings, root);
  const files = await piliNaraFilesIn(settings, entries);
  const folder = entries.find((x) => x.url === webDavBackupDirectory(settings) && x.collection);
  const backupExists = !!folder && (await listWebDavDirectory(settings, folder.url)).some((x) => x.url === webDavBackupUrl(settings) && !x.collection);
  return { backupExists, piliNaraFiles: files };
}

// 远端内容不可信：沿用文件导入的迁移、形状清洗和 NON_PORTABLE 隔离，再交给恢复流程。
export function parseWebDavBackup(raw: string): Record<string, any> {
  if (!raw || raw.length > WEBDAV_BACKUP_MAX) throw new Error('备份文件为空或超过 2MB');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('远端文件不是有效的 JSON');
  }
  if (!parsed || ![APP_NAME, 'biliHoyoFairy'].includes(parsed.app) || !parsed.config || typeof parsed.config !== 'object') {
    throw new Error(`远端文件不是 ${APP_NAME} 配置备份`);
  }
  const incoming = sanitizeConfigInput(migrateConfig(structuredClone(parsed.config)));
  NON_PORTABLE.forEach((k) => delete incoming[k]);
  delete incoming.schemaVersion;
  if (!incoming.block || !incoming.allow) throw new Error('远端配置缺少必要的规则结构');
  return incoming;
}

/** 用云端 portable 配置覆盖本机对应字段；WebDAV 凭据、统计与个人状态保持不变。 */
export function restoreWebDavBackup(raw: string): void {
  const incoming = parseWebDavBackup(raw);
  deepMerge(CONFIG as unknown as Record<string, any>, incoming);
  saveConfig();
}

// —— PiliNara 兼容层 ——
// PiliNara 的 WebDAV 文件是完整设置快照：{ setting, video, localCache }。
// 推荐流“屏蔽用户”只对应 localCache.recommendBlockedMids（UID -> 显示名）；
// blackMids 是 B 站账号级黑名单缓存，语义不同，绝不能拿本插件的本地黑名单去覆盖。
export interface PiliNaraBlockedUsers {
  [uid: string]: string;
}

export interface PiliNaraImportResult {
  remoteCount: number;
  added: number;
  localCount: number;
}

export interface PiliNaraWriteResult {
  written: number;
  added: number;
  skippedInvalidUids: number;
}

function isJsonRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeUid(v: unknown): string {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^[1-9]\d{0,19}$/.test(s) ? s : '';
}

function parsePiliNaraDocument(raw: string): Record<string, any> {
  if (!raw || raw.length > WEBDAV_BACKUP_MAX) throw new Error('PiliNara 配置文件为空或超过 2MB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PiliNara 配置文件不是有效的 JSON');
  }
  if (!isJsonRecord(parsed) || !isJsonRecord(parsed.setting) || !isJsonRecord(parsed.video) || !isJsonRecord(parsed.localCache)) {
    throw new Error('文件不符合 PiliNara WebDAV 设置备份结构');
  }
  return parsed;
}

function blockedUsersOf(doc: Record<string, any>): PiliNaraBlockedUsers {
  const raw = doc.localCache.recommendBlockedMids;
  const out: PiliNaraBlockedUsers = Object.create(null) as PiliNaraBlockedUsers;
  if (Array.isArray(raw)) {
    // 兼容 PiliNara 旧版 Set<int> 经 JSON 导出后的数组形式。
    for (const value of raw) {
      const uid = normalizeUid(value);
      if (uid) out[uid] = `UID:${uid}`;
    }
  } else if (isJsonRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const uid = normalizeUid(key);
      if (!uid) continue;
      const name = typeof value === 'string' ? value.trim().slice(0, 200) : '';
      out[uid] = name || `UID:${uid}`;
    }
  } else if (raw != null) {
    throw new Error('PiliNara 的 recommendBlockedMids 字段格式不受支持');
  }
  return out;
}

/** 只读取 PiliNara 的推荐流屏蔽用户；不会把账号级 blackMids 混进来。 */
export function parsePiliNaraBlockedUsers(raw: string): PiliNaraBlockedUsers {
  return blockedUsersOf(parsePiliNaraDocument(raw));
}

/** 将 PiliNara 屏蔽用户并入本插件 UID 黑名单（仅增不删）。 */
export function importPiliNaraBlockedUsers(raw: string): PiliNaraImportResult {
  const remote = parsePiliNaraBlockedUsers(raw);
  const seen = new Set(CONFIG.block.uids.map(String));
  let added = 0;
  let namesChanged = false;
  for (const [uid, name] of Object.entries(remote)) {
    if (!seen.has(uid)) {
      seen.add(uid);
      CONFIG.block.uids.push(uid);
      added++;
    }
    if (name && CONFIG.uidNames[uid] !== name) {
      setUidName(uid, name);
      namesChanged = true;
    }
  }
  if (added || namesChanged) saveConfig();
  return { remoteCount: Object.keys(remote).length, added, localCount: CONFIG.block.uids.length };
}

// JSON.stringify 会把形如 UID 的整数键按数值重排，可能让“追加项”跑到文件前面。
// 用一次性占位符序列化外壳，再按明确的 entries 顺序写回这一小段对象，保证新增 UID 真正在末尾。
function stringifyPiliNaraDocument(doc: Record<string, any>, entries: Array<[string, string]>, originalMap = ''): string {
  const marker = `__bfb_pilinara_blocked_${Date.now()}_${Math.random()}__`;
  doc.localCache.recommendBlockedMids = marker;
  const shell = JSON.stringify(doc, null, 4);
  const needle = JSON.stringify(marker);
  const span = jsonPropertySpan(shell, ['localCache', 'recommendBlockedMids']);
  const at = span?.start ?? -1;
  if (at < 0) throw new Error('无法生成 PiliNara 屏蔽名单');
  const lineStart = shell.lastIndexOf('\n', at) + 1;
  const indent = (shell.slice(lineStart).match(/^\s*/) || [''])[0];
  const childIndent = indent + '    ';
  const addedJson = entries.map(([uid, name]) => `${childIndent}${JSON.stringify(uid)}: ${JSON.stringify(name)}`).join(',\n');
  const mapJson = originalMap
    ? originalMap.slice(0, -1).trimEnd() + (Object.keys(JSON.parse(originalMap)).length ? ',' : '') + `\n${addedJson}\n${indent}}`
    : entries.length ? `{\n${addedJson}\n${indent}}` : '{}';
  return shell.slice(0, at) + mapJson + shell.slice(at + needle.length);
}

/**
 * 生成更新后的 PiliNara 完整设置文件。以远端 recommendBlockedMids 为基准，重复 UID 保留远端
 * 原值，只把本地新增 UID 追加进去；setting/video、账号级 blackMids、动态/评论名单等全部原样保留。
 * PiliNara 没有独立 BV/AV 黑名单字段，故不写 block.bvids。
 */
export function buildPiliNaraBackupWithMergedBlockedUsers(raw: string): { body: string; result: PiliNaraWriteResult } {
  const doc = parsePiliNaraDocument(raw);
  const oldUsers = blockedUsersOf(doc);
  const original = doc.localCache.recommendBlockedMids;
  const span = isJsonRecord(original) ? jsonPropertySpan(raw, ['localCache', 'recommendBlockedMids']) : null;
  const originalMap = span ? raw.slice(span.start, span.end) : '';
  const next: PiliNaraBlockedUsers = Object.create(null) as PiliNaraBlockedUsers;
  const orderedEntries = originalMap ? [] : Object.entries(oldUsers);
  // 远端条目先进入结果，既保留名称，也表达“本地新增项追加到末尾”的合并语义。
  for (const [uid, name] of Object.entries(oldUsers)) next[uid] = name;
  let added = 0;
  let skippedInvalidUids = 0;
  for (const value of CONFIG.block.uids) {
    const uid = normalizeUid(value);
    if (!uid) {
      skippedInvalidUids++;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(next, uid)) continue;
    next[uid] = CONFIG.uidNames[uid] || `UID:${uid}`;
    orderedEntries.push([uid, next[uid]]);
    added++;
  }
  return {
    body: added ? stringifyPiliNaraDocument(doc, orderedEntries, originalMap) : raw,
    result: { written: (isJsonRecord(original) ? Object.keys(original).length : Object.keys(oldUsers).length) + added, added, skippedInvalidUids },
  };
}

async function piliNaraTarget(settings: WebDavSettings, chosen?: string): Promise<string> {
  if (chosen) {
    const relative = repositoryRelativePath(settings.url, chosen);
    if (!relative || relative.length !== 2 || relative[0].toLowerCase() !== 'pilinara' || !/^piliplus_settings_(phone|pad|desktop)\.json$/i.test(relative[1])) throw new Error('PiliNara 文件不在当前仓库下');
    return chosen;
  }
  const files = await discoverPiliNaraFiles(settings);
  if (!files.length) throw new Error('未找到 PiliNara 配置，请确认仓库下有 PiliNara 文件夹，并先在 PiliNara 中备份设置');
  if (files.length > 1) throw new Error('发现多个 PiliNara 设备备份，请先测试连接并选择要合并的设备');
  return files[0].url;
}

function responseHeader(raw: string, name: string): string {
  const wanted = name.toLowerCase();
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).trim().toLowerCase() === wanted) return line.slice(i + 1).trim();
  }
  return '';
}

/** 从 PiliNara 文件合并读取屏蔽用户到本插件。 */
export async function readPiliNaraBlockedUsers(settings: WebDavSettings, chosen?: string): Promise<PiliNaraImportResult> {
  const response = await webDavRequest(settings, await piliNaraTarget(settings, chosen), 'GET');
  return importPiliNaraBlockedUsers(response.body);
}

/**
 * 读改写 PiliNara 文件：保留远端 recommendBlockedMids，去重后追加本插件缺少的 UID。
 * 服务端提供 ETag 时带 If-Match，阻止两个设备同时保存造成的静默覆盖。
 */
export async function writePiliNaraBlockedUsers(settings: WebDavSettings, chosen?: string): Promise<PiliNaraWriteResult> {
  const target = await piliNaraTarget(settings, chosen);
  const response = await webDavRequest(settings, target, 'GET');
  const updated = buildPiliNaraBackupWithMergedBlockedUsers(response.body);
  if (updated.body.length > WEBDAV_BACKUP_MAX) throw new Error('更新后的 PiliNara 配置超过 2MB，已拒绝写入');
  const etag = responseHeader(response.responseHeaders, 'etag');
  if (updated.result.added) await webDavRequest(settings, target, 'PUT', updated.body, [], etag ? { 'If-Match': etag } : {});
  return updated.result;
}
