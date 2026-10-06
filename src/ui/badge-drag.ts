// 页面角标拖拽：鼠标/触屏统一走 Pointer Events；位置单独持久化，不污染可分享配置。
import { BADGE_POSITION_KEY } from '../constants';

export interface BadgePosition {
  left: number;
  top: number;
}

const EDGE_GAP = 8;
const DRAG_THRESHOLD = 5;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 把角标左上角限制在视口内；极小视口下优先保证左上角可见。 */
export function clampBadgePosition(
  left: number,
  top: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  gap = EDGE_GAP
): BadgePosition {
  const maxLeft = Math.max(0, viewportWidth - width);
  const maxTop = Math.max(0, viewportHeight - height);
  const minLeft = Math.min(gap, maxLeft);
  const minTop = Math.min(gap, maxTop);
  return {
    left: clamp(left, minLeft, Math.max(minLeft, maxLeft - gap)),
    top: clamp(top, minTop, Math.max(minTop, maxTop - gap)),
  };
}

function loadPosition(): BadgePosition | null {
  try {
    const raw = GM_getValue(BADGE_POSITION_KEY, null);
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!p || !Number.isFinite(p.left) || !Number.isFinite(p.top)) return null;
    return { left: Number(p.left), top: Number(p.top) };
  } catch {
    return null;
  }
}

function savePosition(p: BadgePosition): void {
  try {
    GM_setValue(BADGE_POSITION_KEY, JSON.stringify(p));
  } catch {
    // 存储失败只意味着刷新后复位，不能影响角标本身。
  }
}

function place(el: HTMLElement, left: number, top: number): BadgePosition {
  const rect = el.getBoundingClientRect();
  const p = clampBadgePosition(left, top, rect.width, rect.height, window.innerWidth, window.innerHeight);
  el.style.left = `${p.left}px`;
  el.style.top = `${p.top}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  return p;
}

export function installBadgeDrag(el: HTMLElement, onClick: () => void): void {
  if (el.dataset.bfbDrag === '1') return;
  el.dataset.bfbDrag = '1';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;

  let positioned = false;
  const stored = loadPosition();
  if (stored) {
    place(el, stored.left, stored.top);
    positioned = true;
  }

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let offsetX = 0;
  let offsetY = 0;
  let moved = false;
  let suppressClick = false;

  el.addEventListener('pointerdown', (e: PointerEvent) => {
    if (pointerId !== null || !e.isPrimary || e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    moved = false;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 某些脚本管理器的隔离 DOM 不支持 capture；指针仍在元素上时照常可拖。
    }
  });

  el.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
    moved = true;
    positioned = true;
    el.classList.add('dragging');
    el.setAttribute('aria-grabbed', 'true');
    place(el, e.clientX - offsetX, e.clientY - offsetY);
    e.preventDefault();
  });

  const finish = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    el.classList.remove('dragging');
    el.removeAttribute('aria-grabbed');
    if (!moved) return;
    const rect = el.getBoundingClientRect();
    const p = place(el, rect.left, rect.top);
    savePosition(p);
    suppressClick = true;
    // 浏览器会紧接着派发本次手势的 click；若没有派发，不能误吞用户下一次真正的点击。
    setTimeout(() => (suppressClick = false), 0);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);

  el.addEventListener('click', (e: MouseEvent) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onClick();
  });
  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onClick();
  });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (!positioned) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const rect = el.getBoundingClientRect();
      const p = place(el, rect.left, rect.top);
      savePosition(p);
    }, 150);
  });
}
