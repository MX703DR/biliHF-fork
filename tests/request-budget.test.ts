import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { takeMetadataRequest } from '../src/request-budget';
import { REQUEST_BUDGET_KEY } from '../src/constants';
beforeEach(() => { vi.useFakeTimers(); GM_setValue(REQUEST_BUDGET_KEY, '[]'); });
afterEach(() => vi.useRealTimers());
it('补充请求每分钟最多六次，刷新也不能清空预算', () => {
  for (let i = 0; i < 6; i++) expect(takeMetadataRequest()).toBe(true);
  expect(takeMetadataRequest()).toBe(false); vi.advanceTimersByTime(60001); expect(takeMetadataRequest()).toBe(true);
});
it('滚动 24 小时最多六十次，次日释放', () => {
  for (let minute = 0; minute < 10; minute++) {
    for (let i = 0; i < 6; i++) expect(takeMetadataRequest()).toBe(true);
    vi.advanceTimersByTime(60001);
  }
  expect(takeMetadataRequest()).toBe(false); vi.advanceTimersByTime(86400001); expect(takeMetadataRequest()).toBe(true);
});
