import { describe, expect, it } from 'vitest';
import { clampBadgePosition } from '../src/ui/badge-drag';

describe('右下角角标拖拽边界', () => {
  it('把位置限制在视口四周的安全间距内', () => {
    expect(clampBadgePosition(-100, -30, 120, 40, 1000, 800)).toEqual({ left: 8, top: 8 });
    expect(clampBadgePosition(990, 790, 120, 40, 1000, 800)).toEqual({ left: 872, top: 752 });
    expect(clampBadgePosition(300, 200, 120, 40, 1000, 800)).toEqual({ left: 300, top: 200 });
  });

  it('视口比角标还小时仍保证左上角可见', () => {
    expect(clampBadgePosition(20, 20, 120, 40, 80, 30)).toEqual({ left: 0, top: 0 });
  });
});
