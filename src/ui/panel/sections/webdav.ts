// 只需仓库地址和凭据；自动发现 PiliNara 设备文件，本插件只写自己的固定目录。
import { discoverPiliNaraFiles, downloadWebDavBackup, loadWebDavSettings, readPiliNaraBlockedUsers, restoreWebDavBackup, saveWebDavSettings, testWebDavConnection, uploadWebDavBackup, webDavBackupUrl, writePiliNaraBlockedUsers } from '../../../webdav';
import type { PiliNaraFile, WebDavSettings } from '../../../webdav';
import { APP_NAME } from '../../../constants';
import { rescanAfterRuleChange } from '../../../dom';
import { confirmModal } from '../../confirm';
import { toast, updateBadge } from '../../toast';
import { q } from '../ctx';
import type { PanelSection } from '../ctx';

export const webdavSection: PanelSection = {
  tab: 'tools',
  render(host, ctx) {
    const saved = loadWebDavSettings();
    const sec = document.createElement('div'); sec.className = 'sec';
    sec.innerHTML = `<label>☁ WebDAV 配置备份</label>
      <div class="bfb-webdav-fields">
        <label for="bfb-wd-url">WebDAV 仓库地址<input type="url" id="bfb-wd-url" placeholder="https://dav.example.com/dav/" autocomplete="off"></label>
        <label for="bfb-wd-user">用户名<input type="text" id="bfb-wd-user" placeholder="WebDAV 用户名" autocomplete="username"></label>
        <label for="bfb-wd-pass">密钥 / 应用专用密码<input type="password" id="bfb-wd-pass" placeholder="WebDAV 密钥或应用专用密码" autocomplete="current-password"></label>
      </div>
      <div class="hint" id="bfb-wd-path"></div>
      <div class="toolbar" style="margin-top:8px">
        <button class="act ghost" id="bfb-wd-save">保存设置</button><button class="act ghost" id="bfb-wd-test">测试连接</button>
        <button class="act" id="bfb-wd-upload">立即备份</button><button class="act ghost" id="bfb-wd-restore">从云端恢复</button>
      </div>
      <div class="stat" id="bfb-wd-status" style="margin-top:7px"></div>
      <label id="bfb-wd-devices" hidden>PiliNara 设备备份<select id="bfb-wd-device" aria-label="PiliNara 设备备份"></select></label>
      <div class="hint" id="bfb-wd-found"></div>
      <div class="toolbar" style="margin-top:8px">
        <button class="act ghost" id="bfb-wd-pilinara-read">从 PiliNara 合并用户</button><button class="act ghost" id="bfb-wd-pilinara-write">向 PiliNara 合并用户</button>
      </div>
      <div class="hint">填写仓库目录，不是文件地址。备份时自动创建 <code>${APP_NAME}/</code>，配置保存在其中的 <code>config.json</code>。自动查找仓库下的 <code>PiliNara/</code>；多个设备备份需从识别结果中选择，无需手填文件路径。</div>
      <div class="hint">PiliNara 仅同步 UID 黑名单，对应 <code>localCache.recommendBlockedMids</code>。两个方向都去重追加，不删除已有用户，不修改其他设置；不支持 BV/AV 视频名单。</div>
      <div class="hint">配置备份不含 WebDAV 密钥、运行统计及个人状态。凭据只保存在本机；建议使用 HTTPS。填写或保存地址不会联网。“测试连接”先用不带凭据的只读请求申请访问该域名；若油猴提示，请只允许当前 WebDAV 域名，无需允许所有网站。插件不能代替你批准管理器权限。</div>`;
    host.appendChild(sec);
    const url = q<HTMLInputElement>(sec, '#bfb-wd-url'); const username = q<HTMLInputElement>(sec, '#bfb-wd-user');
    const password = q<HTMLInputElement>(sec, '#bfb-wd-pass'); const status = q(sec, '#bfb-wd-status');
    const device = q<HTMLSelectElement>(sec, '#bfb-wd-device'); const devices = q(sec, '#bfb-wd-devices');
    const found = q(sec, '#bfb-wd-found'); const path = q(sec, '#bfb-wd-path');
    const buttons = Array.from(sec.querySelectorAll<HTMLButtonElement>('button'));
    url.value = saved.url; username.value = saved.username; password.value = saved.password;
    let files: PiliNaraFile[] = []; let discoveryKey = '';
    const key = (s: WebDavSettings) => JSON.stringify([s.url, s.username, s.password]);
    const showPath = (s: WebDavSettings) => { path.textContent = s.url ? `本插件备份：${webDavBackupUrl(s)}；联网目标：${new URL(s.url).hostname}` : `本插件备份：仓库/${APP_NAME}/config.json`; };
    showPath(saved);
    const readAndSave = () => {
      const s = saveWebDavSettings({ url: url.value, username: username.value, password: password.value });
      url.value = s.url; showPath(s); return s;
    };
    const setBusy = (busy: boolean) => { buttons.forEach((b) => b.disabled = busy); device.disabled = busy; };
    const fail = (e: unknown) => { const msg = e instanceof Error ? e.message : String(e); status.textContent = `失败：${msg}`; toast(`WebDAV：${msg}`, 'error'); };
    const setFiles = (s: WebDavSettings, next: PiliNaraFile[]) => {
      const previous = discoveryKey === key(s) ? device.value : '';
      files = next; discoveryKey = key(s); device.replaceChildren();
      if (files.length > 1) device.add(new Option('请选择要合并的设备', ''));
      for (const f of files) device.add(new Option(`${({ phone: '手机', pad: '平板', desktop: '桌面' } as Record<string, string>)[f.device]} · ${f.name}`, f.url));
      if (previous && files.some((f) => f.url === previous)) device.value = previous;
      devices.hidden = files.length <= 1;
      found.textContent = files.length === 1 ? `已识别 PiliNara：${files[0].url}` : files.length ? `已识别 ${files.length} 个 PiliNara 设备备份，请选择后合并。` : '尚未识别 PiliNara 备份。请先在 PiliNara 中备份设置，再测试连接。';
    };
    for (const field of [url, username, password]) field.addEventListener('input', () => { files = []; discoveryKey = ''; device.replaceChildren(); devices.hidden = true; found.textContent = ''; });
    const chosenFile = async (s: WebDavSettings) => {
      if (discoveryKey !== key(s)) setFiles(s, await discoverPiliNaraFiles(s));
      if (!files.length) throw new Error('未找到 PiliNara 配置，请先在 PiliNara 中备份设置，并确认仓库目录正确');
      if (files.length > 1 && !device.value) throw new Error('请先选择要合并的 PiliNara 设备备份');
      return files.length === 1 ? files[0].url : device.value;
    };
    q(sec, '#bfb-wd-save').onclick = () => { try { readAndSave(); status.textContent = '设置已保存，点击“测试连接”自动识别目录与设备备份'; toast('WebDAV 设置已保存', 'success'); } catch (e) { fail(e); } };
    q(sec, '#bfb-wd-test').onclick = async () => {
      setBusy(true); status.textContent = '正在申请 WebDAV 域名访问并验证仓库；若油猴提示，请允许该域名…';
      try {
        const s = readAndSave(); const result = await testWebDavConnection(s); setFiles(s, result.piliNaraFiles);
        status.textContent = result.backupExists ? '连接成功，已找到本插件备份' : '连接成功，点击“立即备份”自动创建本插件目录和配置文件';
        toast('WebDAV 连接成功', 'success');
      } catch (e) { fail(e); } finally { setBusy(false); }
    };
    q(sec, '#bfb-wd-upload').onclick = async () => {
      setBusy(true); status.textContent = '正在创建备份目录并上传配置…';
      try { await uploadWebDavBackup(readAndSave()); status.textContent = `最近备份成功：${new Date().toLocaleString()}`; toast('配置已备份到 WebDAV', 'success'); }
      catch (e) { fail(e); } finally { setBusy(false); }
    };
    q(sec, '#bfb-wd-restore').onclick = async () => {
      setBusy(true);
      try {
        const s = readAndSave();
        if (!await confirmModal('从 WebDAV 恢复规则与过滤开关？\n\n对应配置以云端备份为准；凭据、统计与个人状态不变。', { title: '从 WebDAV 恢复', okText: '恢复' })) return;
        status.textContent = '正在下载并校验配置备份…'; restoreWebDavBackup(await downloadWebDavBackup(s));
        rescanAfterRuleChange(); updateBadge(); toast('已从 WebDAV 恢复配置', 'success'); ctx.rerender();
      } catch (e) { fail(e); } finally { setBusy(false); }
    };
    q(sec, '#bfb-wd-pilinara-read').onclick = async () => {
      setBusy(true); status.textContent = '正在识别并读取 PiliNara 屏蔽用户…';
      try {
        const s = readAndSave(); const result = await readPiliNaraBlockedUsers(s, await chosenFile(s));
        rescanAfterRuleChange(); updateBadge(); status.textContent = `已读取 ${result.remoteCount} 个用户，新增 ${result.added} 个；本地现有 ${result.localCount} 个 UID`;
        toast(`已从 PiliNara 合并 ${result.added} 个屏蔽用户`, 'success');
      } catch (e) { fail(e); } finally { setBusy(false); }
    };
    q(sec, '#bfb-wd-pilinara-write').onclick = async () => {
      setBusy(true);
      try {
        const s = readAndSave(); const chosen = await chosenFile(s);
        if (!await confirmModal(`将本插件 UID 黑名单合并到 ${files.find((f) => f.url === chosen)?.name}？\n\n重复 UID 跳过，新增 UID 追加到末尾，不删除或替换已有用户；其他设置不变。`, { title: '合并 PiliNara 屏蔽名单', okText: '合并' })) return;
        status.textContent = '正在校验并更新 PiliNara 配置…'; const result = await writePiliNaraBlockedUsers(s, chosen);
        status.textContent = `已向 PiliNara 新增 ${result.added} 个用户，远端共 ${result.written} 个${result.skippedInvalidUids ? `，跳过 ${result.skippedInvalidUids} 个非数字 UID` : ''}`;
        toast(`已向 PiliNara 合并 ${result.added} 个屏蔽用户`, 'success');
      } catch (e) { fail(e); } finally { setBusy(false); }
    };
  },
};
