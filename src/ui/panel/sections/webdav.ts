// 本插件备份与 PiliPlus 同步独立：自定义文件路径，可选另一套 WebDAV 登录。
import { EMPTY_PILIPLUS, discoverPiliPlusFiles, downloadWebDavBackup, loadWebDavSettings, piliPlusConnection, readPiliPlusBlockedUsers, restoreWebDavBackup, saveWebDavSettings, testPiliPlusConnection, testWebDavConnection, uploadWebDavBackup, webDavBackupUrl, writePiliPlusBlockedUsers } from '../../../webdav';
import { resolveWebDavFilePath } from '../../../webdav-directory';
import type { PiliPlusFile, WebDavSettings } from '../../../webdav';
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
        <button class="act ghost" id="bfb-wd-save">保存设置</button><button class="act ghost" id="bfb-wd-test">测试备份连接</button>
        <button class="act" id="bfb-wd-upload">立即备份</button><button class="act ghost" id="bfb-wd-restore">从云端恢复</button>
      </div>
      <div class="stat" id="bfb-wd-status" style="margin-top:7px"></div>
      <label style="margin-top:14px">PiliPlus 屏蔽名单同步</label>
      <div class="bfb-webdav-fields">
        <label for="bfb-wd-piliplus-path">配置文件 / 目录路径<input type="text" id="bfb-wd-piliplus-path" placeholder="/piliplus/PiliPlus/piliplus_settings_phone.json" autocomplete="off"></label>
      </div>
      <div class="hint">路径从 WebDAV 仓库根目录算起，保留云端实际文件夹名称。填写文件名则使用该文件；仅填写目录则默认使用其中的 <code>piliplus_settings_phone.json</code>。留空时自动查找仓库下的 <code>PiliPlus/</code>。</div>
      <div class="toolbar" style="margin:8px 0">
        <button class="act ghost" id="bfb-wd-piliplus-separate" type="button" role="switch" aria-checked="false">使用独立 WebDAV 登录：关闭</button>
      </div>
      <div class="bfb-webdav-fields" id="bfb-wd-piliplus-fields" hidden>
        <label for="bfb-wd-piliplus-url">PiliPlus WebDAV 仓库地址<input type="url" id="bfb-wd-piliplus-url" placeholder="https://dav.example.com/dav/" autocomplete="off"></label>
        <label for="bfb-wd-piliplus-user">PiliPlus 用户名<input type="text" id="bfb-wd-piliplus-user" autocomplete="off"></label>
        <label for="bfb-wd-piliplus-pass">PiliPlus 密钥 / 应用专用密码<input type="password" id="bfb-wd-piliplus-pass" autocomplete="off"></label>
      </div>
      <div class="hint" id="bfb-wd-piliplus-target"></div>
      <label id="bfb-wd-devices" hidden>PiliPlus 设备备份<select id="bfb-wd-device" aria-label="PiliPlus 设备备份"></select></label>
      <div class="hint" id="bfb-wd-found"></div>
      <div class="toolbar" style="margin-top:8px">
        <button class="act ghost" id="bfb-wd-piliplus-test">测试 PiliPlus 文件</button>
        <button class="act ghost" id="bfb-wd-piliplus-read">从 PiliPlus 合并用户</button><button class="act ghost" id="bfb-wd-piliplus-write">向 PiliPlus 合并用户</button>
      </div>
      <div class="hint">关闭独立登录时，PiliPlus 使用上方本插件的 WebDAV 地址和凭据；开启后仅 PiliPlus 使用独立服务，不影响本插件备份。多个自动识别的设备备份需手动选择。</div>
      <div class="hint">本插件填写仓库目录，不是文件地址。备份时自动创建 <code>${APP_NAME}/</code>，配置保存在其中的 <code>config.json</code>。测试连接与测试文件均只读，不创建或修改云端文件。</div>
      <div class="hint">PiliPlus 仅同步 UID 黑名单，对应 <code>localcache.recommendBlockedMids</code>（兼容 <code>localCache</code>）。两个方向都去重追加，不删除已有用户，不修改其他设置；不支持 BV/AV 视频名单。</div>
      <div class="hint">配置备份不含两套 WebDAV 凭据、运行统计及个人状态。凭据只保存在本机；建议使用 HTTPS。填写或保存地址不会联网。两个测试按钮均先用不带凭据的只读请求申请访问对应域名；若油猴提示，请只允许该域名，无需允许所有网站。插件不能代替你批准管理器权限。</div>`;
    host.appendChild(sec);
    const url = q<HTMLInputElement>(sec, '#bfb-wd-url'); const username = q<HTMLInputElement>(sec, '#bfb-wd-user');
    const password = q<HTMLInputElement>(sec, '#bfb-wd-pass'); const status = q(sec, '#bfb-wd-status');
    const device = q<HTMLSelectElement>(sec, '#bfb-wd-device'); const devices = q(sec, '#bfb-wd-devices');
    const found = q(sec, '#bfb-wd-found'); const path = q(sec, '#bfb-wd-path');
    const piliPath = q<HTMLInputElement>(sec, '#bfb-wd-piliplus-path'); const piliTarget = q(sec, '#bfb-wd-piliplus-target');
    const piliUrl = q<HTMLInputElement>(sec, '#bfb-wd-piliplus-url'); const piliUser = q<HTMLInputElement>(sec, '#bfb-wd-piliplus-user');
    const piliPass = q<HTMLInputElement>(sec, '#bfb-wd-piliplus-pass'); const piliFields = q(sec, '#bfb-wd-piliplus-fields');
    const separateButton = q<HTMLButtonElement>(sec, '#bfb-wd-piliplus-separate');
    const buttons = Array.from(sec.querySelectorAll<HTMLButtonElement>('button'));
    url.value = saved.url; username.value = saved.username; password.value = saved.password;
    const p = saved.piliPlus || EMPTY_PILIPLUS; let separate = p.separate;
    piliPath.value = p.path; piliUrl.value = p.url; piliUser.value = p.username; piliPass.value = p.password;
    let files: PiliPlusFile[] = []; let discoveryKey = '';
    const values = (): WebDavSettings => ({ url: url.value, username: username.value, password: password.value,
      piliPlus: { path: piliPath.value, separate, url: piliUrl.value, username: piliUser.value, password: piliPass.value } });
    const key = (s: WebDavSettings) => JSON.stringify([piliPlusConnection(s), s.piliPlus?.path || '']);
    const showSeparate = () => {
      piliFields.hidden = !separate; separateButton.setAttribute('aria-checked', String(separate));
      separateButton.textContent = `使用独立 WebDAV 登录：${separate ? '开启' : '关闭'}`;
    };
    const showPath = (s: WebDavSettings) => {
      try { path.textContent = s.url.trim() ? `本插件备份：${webDavBackupUrl(s)}` : `本插件备份：仓库/${APP_NAME}/config.json`; }
      catch { path.textContent = '请填写有效的本插件 WebDAV 仓库地址'; }
      try {
        const connection = piliPlusConnection(s);
        piliTarget.textContent = `${s.piliPlus?.separate ? '独立服务' : '共用本插件服务'} · PiliPlus：${s.piliPlus?.path.trim() ? resolveWebDavFilePath(connection.url, s.piliPlus.path) : connection.url + 'PiliPlus/（自动识别）'}`;
      } catch { piliTarget.textContent = separate ? '请填写独立 WebDAV 地址与配置路径' : 'PiliPlus 默认共用本插件的 WebDAV 地址与凭据'; }
    };
    showSeparate();
    showPath(saved);
    const readAndSave = () => {
      const s = saveWebDavSettings(values());
      url.value = s.url; if (s.piliPlus?.separate) piliUrl.value = s.piliPlus.url; showPath(s); return s;
    };
    const setBusy = (busy: boolean) => { buttons.forEach((b) => b.disabled = busy); device.disabled = busy; };
    const fail = (e: unknown) => { const msg = e instanceof Error ? e.message : String(e); status.textContent = `失败：${msg}`; toast(`WebDAV：${msg}`, 'error'); };
    const setFiles = (s: WebDavSettings, next: PiliPlusFile[]) => {
      const previous = discoveryKey === key(s) ? device.value : '';
      files = next; discoveryKey = key(s); device.replaceChildren();
      if (files.length > 1) device.add(new Option('请选择要合并的设备', ''));
      for (const f of files) device.add(new Option(`${({ phone: '手机', pad: '平板', desktop: '桌面', custom: '自定义' } as Record<string, string>)[f.device]} · ${f.name}`, f.url));
      if (previous && files.some((f) => f.url === previous)) device.value = previous;
      devices.hidden = files.length <= 1;
      found.textContent = files.length === 1 ? `选用 PiliPlus 文件：${files[0].url}` : files.length ? `已识别 ${files.length} 个 PiliPlus 设备备份，请选择后测试或合并。` : '尚未识别 PiliPlus 备份。请填写实际路径，或先在 PiliPlus 中备份设置。';
    };
    const invalidate = () => { files = []; discoveryKey = ''; device.replaceChildren(); devices.hidden = true; found.textContent = ''; showPath(values()); };
    for (const field of [url, username, password, piliPath, piliUrl, piliUser, piliPass]) field.addEventListener('input', invalidate);
    separateButton.onclick = () => { separate = !separate; showSeparate(); invalidate(); };
    const chosenFile = async (s: WebDavSettings) => {
      if (discoveryKey !== key(s)) setFiles(s, await discoverPiliPlusFiles(s));
      if (!files.length) throw new Error('未找到 PiliPlus 配置，请先在 PiliPlus 中备份设置，并确认仓库目录正确');
      if (files.length > 1 && !device.value) throw new Error('请先选择要合并的 PiliPlus 设备备份');
      return files.length === 1 ? files[0].url : device.value;
    };
    q(sec, '#bfb-wd-save').onclick = () => { try { readAndSave(); status.textContent = '设置已保存在本机，未联网。可分别测试备份连接和 PiliPlus 文件'; toast('WebDAV 设置已保存', 'success'); } catch (e) { fail(e); } };
    q(sec, '#bfb-wd-test').onclick = async () => {
      setBusy(true); status.textContent = '正在申请 WebDAV 域名访问并验证仓库；若油猴提示，请允许该域名…';
      try {
        const result = await testWebDavConnection(readAndSave());
        status.textContent = result.backupExists ? '连接成功，已找到本插件备份' : '连接成功，点击“立即备份”自动创建本插件目录和配置文件';
        toast('WebDAV 连接成功', 'success');
      } catch (e) { fail(e); } finally { setBusy(false); }
    };
    q(sec, '#bfb-wd-piliplus-test').onclick = async () => {
      setBusy(true); status.textContent = '正在申请 PiliPlus WebDAV 域名访问并只读校验配置文件…';
      try {
        const s = readAndSave();
        const selected = discoveryKey === key(s) && device.value ? device.value : undefined;
        try {
          const result = await testPiliPlusConnection(s, selected);
          if (discoveryKey !== key(s)) setFiles(s, await discoverPiliPlusFiles(s));
          status.textContent = `PiliPlus 文件可读，格式有效，共 ${result.remoteCount} 个屏蔽用户；未修改云端文件`;
          toast('PiliPlus 文件连接成功', 'success');
        } catch (e) {
          // 首次自动发现多个设备时显示选择框，不擅自选手机或覆盖第一份文件。
          if (e instanceof Error && e.message.startsWith('发现多个 PiliPlus')) setFiles(s, await discoverPiliPlusFiles(s));
          throw e;
        }
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
    q(sec, '#bfb-wd-piliplus-read').onclick = async () => {
      setBusy(true); status.textContent = '正在识别并读取 PiliPlus 屏蔽用户…';
      try {
        const s = readAndSave(); const result = await readPiliPlusBlockedUsers(s, await chosenFile(s));
        rescanAfterRuleChange(); updateBadge(); status.textContent = `已读取 ${result.remoteCount} 个用户，新增 ${result.added} 个；本地现有 ${result.localCount} 个 UID`;
        toast(`已从 PiliPlus 合并 ${result.added} 个屏蔽用户`, 'success');
      } catch (e) { fail(e); } finally { setBusy(false); }
    };
    q(sec, '#bfb-wd-piliplus-write').onclick = async () => {
      setBusy(true);
      try {
        const s = readAndSave(); const chosen = await chosenFile(s);
        if (!await confirmModal(`将本插件 UID 黑名单合并到 ${files.find((f) => f.url === chosen)?.name}？\n\n重复 UID 跳过，新增 UID 追加到末尾，不删除或替换已有用户；其他设置不变。`, { title: '合并 PiliPlus 屏蔽名单', okText: '合并' })) return;
        status.textContent = '正在校验并更新 PiliPlus 配置…'; const result = await writePiliPlusBlockedUsers(s, chosen);
        status.textContent = `已向 PiliPlus 新增 ${result.added} 个用户，远端共 ${result.written} 个${result.skippedInvalidUids ? `，跳过 ${result.skippedInvalidUids} 个非数字 UID` : ''}`;
        toast(`已向 PiliPlus 合并 ${result.added} 个屏蔽用户`, 'success');
      } catch (e) { fail(e); } finally { setBusy(false); }
    };
  },
};
