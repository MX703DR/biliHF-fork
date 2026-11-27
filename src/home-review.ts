import type { CardInfo } from './cardinfo';
import { CONFIG } from './config';
import { ATTR_API, ATTR_BLOCKED, PROCESSED } from './constants';
import { matchRule } from './match/engine';
import { cellOf, isBilibiliHome, isUnsafeHideTarget } from './page';

interface Slot {
  original: HTMLElement;
  parent: HTMLElement;
  previous: Element | null;
  next: Element | null;
  index: number;
  template: HTMLElement;
}

interface ReviewEntry {
  info: CardInfo;
  slots: Slot[];
  attempted: boolean;
  restored?: HTMLElement;
}

const entries = new Map<string, ReviewEntry>();
const restoredCards = new WeakSet<HTMLElement>();
export const isRestoredHomeReviewCard = (card: HTMLElement): boolean => restoredCards.has(card);

function videoLink(bvid: string): string {
  return `a[href*="/video/${bvid}/"],a[href$="/video/${bvid}"],a[href*="/video/${bvid}?"]`;
}

export function rememberHomeReviewCard(card: Element, info: CardInfo): void {
  if (!isBilibiliHome() || !(card instanceof HTMLElement) || !card.isConnected ||
      !/^BV[0-9A-Za-z]+$/.test(info.bvid) || !card.querySelector(videoLink(info.bvid)) ||
      restoredCards.has(card)) return;
  const cell = cellOf(card);
  if (isUnsafeHideTarget(cell)) return;
  const old = entries.get(info.bvid);
  if (old?.slots[0].original === card) return;
  const slots: Slot[] = [];
  for (let el: HTMLElement | null = card; el?.parentElement; el = el.parentElement) {
    const parent = el.parentElement;
    slots.push({ original: el, parent, previous: el.previousElementSibling, next: el.nextElementSibling,
      index: Array.from(parent.children).indexOf(el), template: el.cloneNode(true) as HTMLElement });
    if (el === cell) break;
  }
  if (!slots.length) return;
  old?.restored?.remove();
  entries.delete(info.bvid);
  entries.set(info.bvid, { info: { ...info }, slots, attempted: old?.attempted ?? false });
  if (entries.size > 100) {
    const first = entries.keys().next().value!;
    entries.get(first)?.restored?.remove();
    entries.delete(first);
  }
}

let scheduled = false;

export function scheduleHomeReview(mark: (card: HTMLElement, reason: string, info: CardInfo) => void): void {
  if (!entries.size) return;
  if (!CONFIG.enabled || !CONFIG.reviewMode || !isBilibiliHome()) {
    for (const entry of entries.values()) {
      entry.restored?.remove();
      entry.restored = undefined;
      entry.attempted = false;
    }
    return;
  }
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!CONFIG.enabled || !CONFIG.reviewMode || !isBilibiliHome()) return;
    for (const [bvid, entry] of entries) {
      const slot = entry.slots.find(({ parent }) => parent.isConnected);
      if (!slot) {
        entry.restored?.remove();
        entries.delete(bvid);
        continue;
      }
      const reason = matchRule(entry.info);
      const originalBack = entry.slots[0].original.isConnected && entry.slots[0].original.querySelector(videoLink(bvid));
      if (!reason || originalBack) {
        entry.restored?.remove();
        entry.restored = undefined;
        continue;
      }
      // 外部移除也保留本轮的恢复记录，否则每次 DOM 扫描都会重插同一张卡。
      if (entry.attempted) continue;
      const restored = slot.template.cloneNode(true) as HTMLElement;
      const card = slot === entry.slots[0] ? restored : restored.querySelector<HTMLElement>('.bili-video-card');
      if (!card) continue;
      // 脱离原组件的卡使用屏蔽前的原站标记。清除旧状态，避免扫描器和原卡争夺显隐。
      for (const el of [restored, ...restored.querySelectorAll('[id], [data-bfb-done], [data-bfb-blocked], .bfb-review')]) {
        el.removeAttribute('id');
        el.removeAttribute(PROCESSED);
        el.removeAttribute(ATTR_BLOCKED);
        el.removeAttribute(ATTR_API);
        el.classList.remove('bfb-review');
      }
      restored.querySelectorAll('.bfb-tag').forEach(el => el.remove());
      card.setAttribute(PROCESSED, '1');
      restoredCards.add(card);
      mark(card, reason, entry.info);
      const { parent, next, previous, index } = slot;
      const anchor = next?.parentElement === parent ? next :
        previous?.parentElement === parent ? previous.nextElementSibling : parent.children[index] || null;
      entry.attempted = true;
      parent.insertBefore(restored, anchor);
      entry.restored = restored;
    }
  });
}
