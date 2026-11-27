import { cachedCardInfo } from './cardinfo';
import type { CardInfo } from './cardinfo';
import { CONFIG } from './config';
import { matchRule } from './match/engine';
import { isBilibiliHome } from './page';
import { HOME_RECOMMEND_CONTAINER } from './selectors';

const recent = new Map<string, { info: CardInfo; cover: string }>();
const MAX_RECENT = 40;

// 在右键或悬停动作的同一轮调用中保存，原站反馈和 Vue 重绘都可能随后移除原卡。
export function rememberHomeReviewCard(card: Element, info: CardInfo): void {
  if (!isBilibiliHome() || !card.isConnected || !/^BV[0-9A-Za-z]+$/.test(info.bvid)) return;
  const image = card.querySelector<HTMLImageElement>('.bili-video-card__image img, .bili-video-card__cover img');
  const cover = image?.currentSrc || image?.src || '';
  recent.delete(info.bvid);
  recent.set(info.bvid, { info: { ...info }, cover: /^https:\/\/[\w.-]+\.hdslb\.com\//i.test(cover) ? cover : '' });
  if (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value!);
}

let section: HTMLElement | undefined;
let revision = '';
let scheduled = false;

export function scheduleHomeReview(mark: (card: HTMLElement, reason: string, info: CardInfo) => void): void {
  if (!CONFIG.enabled || !CONFIG.reviewMode || !isBilibiliHome()) {
    section?.remove();
    section = undefined;
    revision = '';
    return;
  }
  if (!recent.size || scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!CONFIG.enabled || !CONFIG.reviewMode || !isBilibiliHome()) return;

    const visible = new Set<string>();
    for (const card of document.querySelectorAll('.bfb-review')) {
      const bvid = cachedCardInfo(card)?.bvid;
      if (bvid && recent.has(bvid) && card.getClientRects().length && getComputedStyle(card).visibility === 'visible') visible.add(bvid);
    }
    const missing = [...recent.values()].reverse().flatMap(({ info, cover }) => {
      const reason = !visible.has(info.bvid) && matchRule(info);
      return reason ? [{ info, cover, reason }] : [];
    });
    if (!missing.length) {
      section?.remove();
      return;
    }

    const key = JSON.stringify(missing);
    if (key === revision && section?.isConnected) return;
    revision = key;
    section ??= document.createElement('section');
    section.id = 'bfb-home-review';
    const heading = document.createElement('h2');
    heading.textContent = '最近屏蔽的视频';
    const list = document.createElement('div');
    list.className = 'bfb-home-review-list';
    for (const { info, cover, reason } of missing) {
      const card = document.createElement('article');
      card.className = 'bfb-home-review-card';
      const link = document.createElement('a');
      link.href = 'https://www.bilibili.com/video/' + info.bvid + '/';
      if (cover) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = cover;
        link.append(img);
      }
      const title = document.createElement('strong');
      title.textContent = info.title || info.bvid;
      link.append(title);
      const author = document.createElement('span');
      author.textContent = info.up;
      card.append(link, author);
      mark(card, reason, info);
      list.append(card);
    }
    section.replaceChildren(heading, list);
    if (!section.isConnected) {
      const grid = document.querySelector(HOME_RECOMMEND_CONTAINER);
      if (grid) grid.before(section);
      else document.body?.prepend(section);
    }
  });
}
