import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { toast } from '../src/ui/toast';

describe('页面通知开关', () => {
  afterEach(() => {
    CONFIG.showNotifications = true;
  });

  it('关闭后在创建任何 DOM 前直接跳过 Toast', () => {
    CONFIG.showNotifications = false;
    // 测试环境没有 document；若没有在最前面短路，这里会直接抛错。
    expect(() => toast('不应显示')).not.toThrow();
  });
});
