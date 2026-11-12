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

const stored = JSON.stringify({ left: 120, top: 100 });
function setupBadge() {
  const viewport = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 });
  vi.stubGlobal('window', viewport);
  GM_setValue(BADGE_POSITION_KEY, stored);
  const classes = new Set<string>();
  const capture = vi.fn();
  const release = vi.fn();
  const style: Record<string, unknown> = { removeProperty: (key: string) => delete style[key] };
  const el = Object.assign(new EventTarget(), {
    dataset: {}, style, setAttribute: vi.fn(), removeAttribute: vi.fn(), setPointerCapture: capture,
    hasPointerCapture: () => true, releasePointerCapture: release,
    classList: {
      add: (cls: string) => classes.add(cls),
      contains: (cls: string) => classes.has(cls),
      remove: (cls: string) => classes.delete(cls),
      toggle: (cls: string, on: boolean) => on ? classes.add(cls) : classes.delete(cls),
    },
    getBoundingClientRect: () => ({ left: 120, top: 100, width: 120, height: 40 }),
  });
  const onClick = vi.fn();
  installBadgeDrag(el as any, onClick);
  const pointer = (type: string, clientX = 500) =>
    el.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, isPrimary: true, button: 0, clientX, clientY: 400 }));
  return { viewport, classes, capture, release, el, onClick, pointer };
}

it('锁定时拖拽不改坐标或存档，解锁恢复原位置且仍可点击', () => {
  const { classes, capture, el, onClick, pointer } = setupBadge();
  try {
    setBadgeLocked(el as any, true);
    expect(classes.has('locked')).toBe(true);
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      pointer(type);
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

it.each([false, true])('视口尺寸变化时复位并清除旧坐标，锁定设置不变（locked=%s）', (locked) => {
  const { viewport, classes, el } = setupBadge();
  try {
    setBadgeLocked(el as any, locked);
    viewport.dispatchEvent(new Event('resize'));
    expect(GM_getValue(BADGE_POSITION_KEY)).toBe(stored);
    viewport.innerWidth -= 200;
    viewport.dispatchEvent(new Event('resize'));
    expect(classes.has('locked')).toBe(locked);
    for (const side of ['left', 'top', 'right', 'bottom']) expect(el.style[side]).toBeUndefined();
    expect(GM_getValue(BADGE_POSITION_KEY, null)).toBeNull();
    setBadgeLocked(el as any, false);
    expect(el.style.left).toBeUndefined();
    expect(el.style.top).toBeUndefined();
  } finally {
    GM_deleteValue(BADGE_POSITION_KEY);
    vi.unstubAllGlobals();
  }
});

it('拖拽过程中改变视口高度，旧手势结束后不会重新保存坐标', () => {
  const { viewport, el, classes, pointer, release } = setupBadge();
  try {
    pointer('pointerdown');
    pointer('pointermove', 600);
    expect(classes.has('dragging')).toBe(true);
    viewport.innerHeight -= 100;
    viewport.dispatchEvent(new Event('resize'));
    pointer('pointerup');
    expect(release).toHaveBeenCalledWith(1);
    expect(el.style.left).toBeUndefined();
    expect(GM_getValue(BADGE_POSITION_KEY, null)).toBeNull();
  } finally {
    GM_deleteValue(BADGE_POSITION_KEY);
    vi.unstubAllGlobals();
  }
});
