import { REQUEST_BUDGET_KEY } from './constants';

/** 只有主动开启的补充取数受此预算约束；用户主动拉黑所必需的解析独立限速。 */
export function takeMetadataRequest(): boolean {
  const now = Date.now();
  let times: number[] = [];
  try {
    const raw = GM_getValue(REQUEST_BUDGET_KEY, '[]');
    if (typeof raw === 'string' && raw.length < 5000) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) times = parsed.filter((x) => Number.isFinite(x) && x <= now && now - x < 86400000).slice(-60);
    }
  } catch { /* 损坏预算从空窗恢复 */ }
  if (times.length >= 60 || times.filter((x) => now - x < 60000).length >= 6) return false;
  try { GM_setValue(REQUEST_BUDGET_KEY, JSON.stringify([...times, now])); } catch { return false; }
  return true;
}
