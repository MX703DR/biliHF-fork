import { describe, expect, it, vi } from 'vitest';
import { BADGE_POSITION_KEY } from '../src/constants';
import { clampBadgePosition, installBadgeDrag, setBadgeLocked } from '../src/ui/badge-drag';

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

it('锁定时拖拽不改坐标或存档，解锁恢复原位置且仍可点击', () => {
  const stored = JSON.stringify({ left: 120, top: 100 });
  GM_setValue(BADGE_POSITION_KEY, stored);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 }));
  const classes = new Set<string>();
  const capture = vi.fn();
  const el = Object.assign(new EventTarget(), {
    dataset: {}, style: {}, setAttribute: vi.fn(), removeAttribute: vi.fn(), setPointerCapture: capture,
    classList: {
      contains: (cls: string) => classes.has(cls),
      remove: (cls: string) => classes.delete(cls),
      toggle: (cls: string, on: boolean) => on ? classes.add(cls) : classes.delete(cls),
    },
    getBoundingClientRect: () => ({ left: 120, top: 100, width: 120, height: 40 }),
  });
  const onClick = vi.fn();
  try {
    installBadgeDrag(el as any, onClick);
    setBadgeLocked(el as any, true);
    expect(classes.has('locked')).toBe(true);
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      el.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, isPrimary: true, button: 0, clientX: 500, clientY: 400 }));
    }
    expect(capture).not.toHaveBeenCalled();
    expect(GM_getValue(BADGE_POSITION_KEY)).toBe(stored);
    el.dispatchEvent(new Event('click'));
    expect(onClick).toHaveBeenCalledOnce();
    setBadgeLocked(el as any, false);
    expect(classes.has('locked')).toBe(false);
    expect(el.style).toMatchObject({ left: '120px', top: '100px' });
  } finally {
    GM_deleteValue(BADGE_POSITION_KEY);
    vi.unstubAllGlobals();
  }
});
