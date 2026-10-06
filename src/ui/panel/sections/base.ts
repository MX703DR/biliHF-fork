// 基础分组：常规开关 + 卡片类型过滤。
import { CONFIG } from '../../../config';
import { rescanAfterRuleChange } from '../../../dom';
import { applyHotSearchStyle } from '../../../hotsearch';
import { bindControl } from '../../field';
import { hideHoverBtn } from '../../menu';
import { updateBadge } from '../../toast';
import { setTimingEnabled } from '../../../health';
import type { PanelSection } from '../ctx';

export const baseSection: PanelSection = {
  tab: 'base',
  render(host) {
    const sw = document.createElement('div');
    sw.className = 'sec';
    sw.innerHTML = `
      <div class="switch"><input type="checkbox" id="bfb-enabled"> 启用拦截</div>
      <div class="switch"><input type="checkbox" id="bfb-review"> 🔍 审查模式（不隐藏，仅标记被拦视频并提供就地放行，便于核对）</div>
      <div class="switch"><input type="checkbox" id="bfb-rclick"> 右键卡片弹出菜单（屏蔽、拉黑、加入白名单）</div>
      <div class="switch"><input type="checkbox" id="bfb-invert-shift-rclick"> 反转 Shift+右键（普通右键显示原生菜单，Shift+右键显示插件菜单）</div>
      <div class="switch"><input type="checkbox" id="bfb-hoverbtn"> 悬停卡片显示快捷「拉黑 / 不看这个」按钮</div>
      <div class="switch"><input type="checkbox" id="bfb-collab"> 联合投稿一并拉黑合作者</div>
      <div class="switch"><input type="checkbox" id="bfb-fuzzy"> 反绕过模糊匹配（「原 神」「原.神」同样拦截；隐形字符始终拦截）</div>
      <div class="switch"><input type="checkbox" id="bfb-trad"> 简繁归一（规则写「原神」也能拦住繁体标题；单向繁→简）</div>
      <div class="switch"><input type="checkbox" id="bfb-debug"> 调试模式（控制台逐卡打印拦截 / 放行原因；并在「工具 → 运行自检」里记录耗时）</div>
      <div class="hint">所有开关与规则<b>即时生效</b>，无需保存。<b>审查模式</b>会让拦截层停止在数据层删项以便核对，切换后建议刷新页面。想让视频真正从推荐流消失请用<b>拉黑</b>。</div>`;
    host.appendChild(sw);
    bindControl(sw, 'bfb-enabled', CONFIG, 'enabled', {
      after: () => {
        updateBadge();
        rescanAfterRuleChange();
      },
    });
    bindControl(sw, 'bfb-review', CONFIG, 'reviewMode', { after: rescanAfterRuleChange });
    bindControl(sw, 'bfb-rclick', CONFIG, 'rightClickBlock');
    bindControl(sw, 'bfb-invert-shift-rclick', CONFIG, 'invertShiftRightClick');
    bindControl(sw, 'bfb-hoverbtn', CONFIG, 'cardHoverBtn', { after: hideHoverBtn });
    bindControl(sw, 'bfb-collab', CONFIG, 'blacklistCollab');
    bindControl(sw, 'bfb-fuzzy', CONFIG, 'fuzzyMatch', { after: rescanAfterRuleChange });
    bindControl(sw, 'bfb-trad', CONFIG, 'tradNorm', { after: rescanAfterRuleChange });
    bindControl(sw, 'bfb-debug', CONFIG, 'debug', {
      after: () => {
        setTimingEnabled(CONFIG.debug); // 顺带开/关耗时采样，结果见「工具 → 🩺 运行自检」
        rescanAfterRuleChange();
      },
    });

    const notices = document.createElement('div');
    notices.className = 'sec';
    notices.innerHTML = `
      <label>通知提示</label>
      <div class="switch"><input type="checkbox" id="bfb-notifications"> 显示页面通知（操作结果、启动汇总等）</div>
      <div id="bfb-notification-options">
        <div class="switch"><input type="checkbox" id="bfb-risk-notifications"> 触发 B 站风控时提醒</div>
      </div>
      <div class="hint">关闭风控提醒只隐藏弹出的提示，联网熔断、暂停和自动退避仍会照常保护账号。拉黑、清空规则、恢复备份等危险操作的确认框不受此开关影响。</div>`;
    host.appendChild(notices);
    const noticeOptions = notices.querySelector<HTMLElement>('#bfb-notification-options')!;
    const syncNoticeOptions = () => {
      noticeOptions.style.opacity = CONFIG.showNotifications ? '1' : '.4';
      noticeOptions.style.pointerEvents = CONFIG.showNotifications ? 'auto' : 'none';
    };
    bindControl(notices, 'bfb-notifications', CONFIG, 'showNotifications', { after: syncNoticeOptions });
    bindControl(notices, 'bfb-risk-notifications', CONFIG, 'showRiskNotifications');
    syncNoticeOptions();

    const ct = document.createElement('div');
    ct.className = 'sec';
    ct.innerHTML = `
      <label>卡片类型过滤</label>
      <div class="switch"><input type="checkbox" id="bfb-ad"> 屏蔽广告 / 推广卡片</div>
      <div class="switch"><input type="checkbox" id="bfb-live"> 屏蔽信息流中的直播推荐卡</div>
      <div class="switch"><input type="checkbox" id="bfb-hotsearch"> 屏蔽搜索框热搜词</div>
      <div class="hint">广告为自动识别，偶有误差，可在「屏蔽记录」核对。直播卡指信息流里指向直播间的推荐卡。</div>`;
    host.appendChild(ct);
    bindControl(ct, 'bfb-ad', CONFIG, 'hideAd', { after: rescanAfterRuleChange });
    bindControl(ct, 'bfb-live', CONFIG, 'hideLiveCard', { after: rescanAfterRuleChange });
    bindControl(ct, 'bfb-hotsearch', CONFIG, 'hideHotSearch', { after: applyHotSearchStyle });
  },
};
