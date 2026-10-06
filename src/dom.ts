// DOM 兜底层：SSR 和其它扩展的卡片在绘制前判定；已由数据层判定的不再补发接口/二次重排。
// 单卡处理有错误边界，异形卡不会中断整轮扫描。
import { CONFIG } from './config';
import { ATTR_API, ATTR_BLOCKED, PROCESSED, GUTTER_RECALC_MS } from './constants';
import { cellOf, isUnsafeHideTarget, UNPROCESSED_CARD_SELECTOR, VIDEO_CARD_SELECTOR } from './page';
import { SWIPE_BANNER } from './selectors';
import { extractCardInfo, cacheCardInfo, cachedCardInfo } from './cardinfo';
import type { CardInfo } from './cardinfo';
import { M, rebuildRules, ruleVersion } from './match/engine';
import { dataVerdict, evaluateVideo, immediateVerdict } from './video-filter';
import type { VideoVerdict } from './video-filter';
import { recordBlock } from './stats';
import { shadowRoots } from './shadow';
import { scanComments } from './comments';
import { addToList } from './rules';
import { log, logErr, safe } from './logging';
import { isInitialStatePending } from './initial-data';
import { health, timed } from './health';
import { hideEl, showEl } from './hide';
import { toast } from './ui/toast';
import { refreshPanelIfOpen } from './ui/hooks';
import { refreshHomeGrid } from './home-grid';

const countedEls = new WeakMap<Element, string>(); // 节点复用为另一视频时仍要计数
const recognizedCards = new WeakSet<HTMLElement>();
let recognizedCount = 0;
const pendingCards = new WeakMap<HTMLElement, object>();
const waitingVisuals = new WeakMap<HTMLElement, { value: string; priority: string }>();
let domBatch: Array<{ result: Promise<VideoVerdict>; apply: (reason: string | null, info: CardInfo) => void; info: CardInfo }> = [];
let batchQueued = false;

function queueVerdict(result: Promise<VideoVerdict>, apply: (reason: string | null, info: CardInfo) => void, info: CardInfo): void {
  domBatch.push({ result, apply, info });
  if (batchQueued) return;
  batchQueued = true;
  queueMicrotask(() => {
    batchQueued = false;
    const batch = domBatch;
    domBatch = [];
    Promise.all(batch.map((job) => job.result.catch(() => ({ reason: null, info: job.info })))).then((results) => {
      // 一轮新增节点的判定一起提交，不能逐张“放行后又被其它卡补位”。
      results.forEach((v, index) => batch[index].apply(v.reason, v.info));
    });
  });
}

function waitForVerdict(card: HTMLElement): void {
  if (!waitingVisuals.has(card)) waitingVisuals.set(card, { value: card.style.getPropertyValue('visibility'), priority: card.style.getPropertyPriority('visibility') });
  card.style.setProperty('visibility', 'hidden', 'important');
}

function endWait(card: HTMLElement): void {
  const saved = waitingVisuals.get(card);
  if (!saved) return;
  waitingVisuals.delete(card);
  if (saved.value) card.style.setProperty('visibility', saved.value, saved.priority);
  else card.style.removeProperty('visibility');
}

// 撤销 DOM 层对某卡的隐藏 / 审查标记（规则变更后重扫时调用）。
function clearVisual(card: HTMLElement) {
  showEl(card);
  card.classList.remove('bfb-review');
  const t = card.querySelector(':scope > .bfb-tag');
  if (t) t.remove();
  card.removeAttribute(ATTR_BLOCKED);
  const cell = cellOf(card) as HTMLElement;
  if (cell !== card) showEl(cell);
}

// 审查模式：不隐藏，给卡片打醒目标记 + 原因 + 就地「放行」按钮，便于核对防误伤。
function markCard(card: HTMLElement, reason: string, info: CardInfo) {
  card.classList.add('bfb-review');
  if (card.querySelector(':scope > .bfb-tag')) return;
  const tag = document.createElement('div');
  tag.className = 'bfb-tag';
  const rs = document.createElement('span');
  rs.className = 'rs';
  rs.textContent = '已判定拦截 · ' + reason;
  tag.appendChild(rs);
  if (info.up || info.uid || info.bvid) {
    const pass = document.createElement('button');
    pass.textContent = '✅放行';
    pass.title = '误伤了？把该 UP 加白名单，永不再拦';
    pass.onclick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (info.uid) addToList(CONFIG.allow.uids, info.uid);
      else if (info.up) addToList(CONFIG.allow.upNames, info.up);
      else if (info.bvid) addToList(CONFIG.allow.keywords, info.title || info.bvid);
      toast('已放行：' + (info.up || info.title || info.bvid));
      refreshPanelIfOpen();
    };
    tag.appendChild(pass);
  }
  card.appendChild(tag);
}

// DOM 兜底层：审查模式标记、否则直接隐藏漏网卡。主路径由网络拦截层在渲染前就删除。
// 有些版式的列间距是靠 `:nth-child(odd){margin-right:Xpx}` 拼出来的（热门页就是这样）。
// 而 display:none **不会重排 nth-child 的序号**：藏掉一项后，后面那项仍按原来的奇偶带着右边距，
// 宽度差那几像素就挤不进空出来的格子 → 换行 → 留下一个补不上的洞。
//
// 修法是把列间距从「子项的奇偶」搬到「容器」上：容器加 column-gap、子项右边距清零。
// 间距值**实测**而非写死（站点在不同断点常换间距），且窗口尺寸变化时整套重算——
// 只测一次就冻住的话，跨过响应式断点后间距就错了。
const gutterBoxes = new Set<HTMLElement>();

// 重新判定并施加/撤销修正。先撤掉自己上一次的手脚，否则读到的 margin 是我们写的 0，
// 站点自己的规则说不上话（这也是「只测一次」那版没法重算的原因：信息来源被自己砸了）。
function applyGutterFix(box: HTMLElement): void {
  box.classList.remove('bfb-gutter-fix');
  box.style.removeProperty('column-gap');
  try {
    const cs = getComputedStyle(box);
    if (!cs.display.includes('flex') || cs.flexWrap !== 'wrap') return;
    if (parseFloat(cs.columnGap) > 0) return; // 站点自己有 gap（首页那种），轮不到我们插手
    // 判据：有的子项带右边距、有的不带——那正是奇偶写法的签名。整齐划一的不动。
    let gutter = 0;
    let sawZero = false;
    for (const ch of Array.from(box.children)) {
      const m = parseFloat(getComputedStyle(ch as HTMLElement).marginRight) || 0;
      if (m > 0) gutter = gutter || m;
      else sawZero = true;
      if (gutter && sawZero) break;
    }
    if (!gutter || !sawZero) return;
    box.style.columnGap = gutter + 'px';
    box.classList.add('bfb-gutter-fix');
    log(() => `列间距改由容器提供（${gutter}px），避免隐藏后 nth-child 奇偶错位`);
  } catch (e) {
    /* 拿不到计算样式：放弃修正，不影响隐藏本身 */
  }
}

let gutterResizeArmed = false;
function armGutterResize(): void {
  if (gutterResizeArmed) return;
  gutterResizeArmed = true;
  let t: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      for (const box of gutterBoxes) {
        if (!box.isConnected) gutterBoxes.delete(box); // 顺手回收，别攥着已脱离文档的容器
        else applyGutterFix(box);
      }
    }, GUTTER_RECALC_MS);
  });
}

function fixParityGutter(box: Element | null): void {
  if (!box || !(box instanceof HTMLElement)) return;
  if (gutterBoxes.has(box)) return; // 每个容器只在首次隐藏时判一次；之后交给 resize 重算
  gutterBoxes.add(box);
  armGutterResize();
  applyGutterFix(box);
}

export function blockVideo(card: HTMLElement, reason: string, info: CardInfo): void {
  if (CONFIG.reviewMode) {
    markCard(card, reason, info);
  } else {
    // 隐藏统一走 hide.ts：文档级 class 到不了影子树（评论宿主、界面替换类扩展的卡片都在里面），
    // 而直接 removeProperty 恢复会删掉站点自己的 display。详见该文件。
    const cell = cellOf(card) as HTMLElement;
    if (!isUnsafeHideTarget(cell)) hideEl(cell);
    hideEl(card);
    fixParityGutter(cell.parentElement);
  }
  card.setAttribute(ATTR_BLOCKED, '1'); // 供「批量拉黑」扫描
  const key = info.bvid || info.uid + ':' + info.title;
  if (countedEls.get(card) === key) return;
  countedEls.set(card, key);
  recordBlock(reason, info, 'DOM');
}

// 单卡处理用错误边界包裹：异形卡导致 extractCardInfo/matchRule 抛错时，只跳过这一张、不中断整轮扫描。
const processCard = safe('processCard', function (card: HTMLElement, fresh = false) {
  if (!CONFIG.enabled) return;
  if (isInitialStatePending(card)) return;
  let info = extractCardInfo(card, M.needUid);
  if (!info.title && !info.up && !info.isLive) {
    // Vue 会把已屏蔽的视频节点复用成加载骨架；撤销本插件的隐藏，不能把旧状态带到新一轮占位。
    if (card.hasAttribute(PROCESSED) || pendingCards.has(card)) {
      pendingCards.delete(card);
      endWait(card);
      clearVisual(card);
      card.removeAttribute(PROCESSED);
      card.removeAttribute(ATTR_API);
      countedEls.delete(card);
      cacheCardInfo(card, info);
    }
    return;
  }
  if (card.closest(SWIPE_BANNER)) return;
  if (!recognizedCards.has(card)) {
    recognizedCards.add(card);
    health.cardsSeen = Math.max(health.cardsSeen, ++recognizedCount);
  }
  const displayed = !fresh && card.hasAttribute(PROCESSED);
  const previous = cachedCardInfo(card);
  if (previous && previous.bvid === info.bvid && previous.title === info.title) {
    info = { ...info, uid: info.uid || previous.uid, partition: info.partition || previous.partition, likes: info.likes ?? previous.likes, views: info.views ?? previous.views };
  }
  card.setAttribute(PROCESSED, '1');
  cacheCardInfo(card, info);
  const token = {};
  pendingCards.set(card, token);
  const version = ruleVersion;
  const apply = (reason: string | null, complete: CardInfo) => {
    if (pendingCards.get(card) !== token || version !== ruleVersion) return;
    pendingCards.delete(card);
    if (!card.isConnected) {
      // 原生渲染模型已移除的卡片，不再用迟到的 DOM 兜底重复计数；复用时重新识别。
      endWait(card); clearVisual(card); card.removeAttribute(PROCESSED); card.removeAttribute(ATTR_API);
      return;
    }
    cacheCardInfo(card, complete);
    if (reason && CONFIG.enabled) {
      if (CONFIG.reviewMode) clearVisual(card);
      else {
        card.classList.remove('bfb-review');
        card.querySelector(':scope > .bfb-tag')?.remove();
      }
      blockVideo(card, reason, complete);
    } else clearVisual(card);
    endWait(card);
  };
  const known = dataVerdict(info.bvid, info.title, info.uid) || immediateVerdict(info);
  if (known) {
    if (!displayed && !CONFIG.reviewMode) waitForVerdict(card);
    queueVerdict(Promise.resolve(known), apply, info);
    return;
  }
  // 新卡尚未绘制时留住格子、不显示内容；一批网络卡根本不会走到这里。
  // 修改已显示视频的屏蔽规则时维持旧显隐，判定后才作一次必要的重新排列。
  if (!displayed && !CONFIG.reviewMode) waitForVerdict(card);
  card.setAttribute(ATTR_API, '1');
  queueVerdict(evaluateVideo(info), apply, info);
});

/** 新增 / 复用节点的窄扫描，MutationObserver 微任务内完成，避免稳态 250ms 扫描前先闪出来。 */
export function scanAddedNode(node: Node): void {
  if (!CONFIG.enabled || node.nodeType !== 1) return;
  const el = node as Element;
  if (el.matches(VIDEO_CARD_SELECTOR) && !el.hasAttribute(PROCESSED)) processCard(el as HTMLElement);
  for (const card of el.querySelectorAll<HTMLElement>(UNPROCESSED_CARD_SELECTOR)) processCard(card);
}

export function inspectChangedCard(node: Node, seen?: Set<HTMLElement>): void {
  if (!CONFIG.enabled) return;
  const el = node.nodeType === 1 ? node as Element : node.parentElement;
  const card = el?.closest<HTMLElement>(VIDEO_CARD_SELECTOR);
  if (!card || card.closest('#bfb-panel, .bfb-tag')) return;
  if (seen?.has(card)) return;
  seen?.add(card);
  const old = cachedCardInfo(card);
  if (!old) { processCard(card); return; }
  const info = extractCardInfo(card, M.needUid);
  if (!info.title && !info.up && !info.isLive) { processCard(card, true); return; }
  if (info.title && (info.bvid !== old.bvid || info.title !== old.title || info.up !== old.up)) processCard(card, true);
}

// 跨主文档与所有存活 shadow root 的查询。
// 单一入口：卡片扫描与规则变更后的重扫必须用同一套根集合——只查主文档会漏掉 shadow 内的卡，
// 导致它们的 PROCESSED 标记永远清不掉、规则改了也不重判（曾经的 bug）。
function queryAllRoots(selector: string): HTMLElement[] {
  const out: HTMLElement[] = Array.from(document.querySelectorAll<HTMLElement>(selector));
  for (const r of shadowRoots) {
    if (!r.host || !r.host.isConnected) continue; // 回收由 shadow.pruneShadowRoots 统一负责
    try {
      const found = r.querySelectorAll<HTMLElement>(selector);
      if (found.length) out.push(...found);
    } catch (e) {
      logErr('queryAllRoots', e); // 选择器/已失效 root 异常：跳过该 root 但要可见
    }
  }
  return out;
}

export function scanAll(): void {
  if (!CONFIG.enabled) return;
  // 只取**未处理**的卡：稳态下页面上绝大多数卡都已处理，把它们全取回来再逐个 getAttribute
  // 是每 250ms 白做一遍的活。语义不变（已处理的本来就会被跳过），只是让选择器引擎代劳。
  const cards = timed('scan.query', () => queryAllRoots(UNPROCESSED_CARD_SELECTOR));
  // 自检取的是「一轮里认出过多少张卡」的峰值。首轮全部未处理，峰值照常取到；
  // 之后只增不减，所以「选择器还认不认得出卡片」这个判据不受影响。
  if (cards.length > health.cardsSeen) health.cardsSeen = cards.length;
  // 循环本身单独计时：scan.query 只量了 querySelectorAll，而稳态下 :not([data-bfb-done])
  // 之后循环里剩的都是「不打标记、每轮重抽」的卡（骨架卡，以及渲染好了但选择器没认出来的），
  // 持续开销恰恰藏在这里。改 extractCardInfo 之前先看这个数。
  timed('scan.cards', () =>
    cards.forEach((card) => {
      if (card.closest && card.closest(SWIPE_BANNER)) return; // 顶部轮播 banner，跳过
      processCard(card);
    })
  );
}

export function rescanAfterRuleChange(): void {
  timed('rules.rebuild', rebuildRules);
  refreshHomeGrid();
  // 必须穿透 shadow：扫描会处理 shadow 内的卡，这里就得能把它们的标记一并清掉
  queryAllRoots('[' + PROCESSED + ']').forEach((el) => {
    el.removeAttribute(ATTR_API);
    pendingCards.delete(el);
    if (!CONFIG.enabled) { clearVisual(el); endWait(el); }
    else processCard(el); // 不先全体显示再隐藏；原来隐藏的仍等新判定完成后才恢复。
  });
  scanAll();
  scanComments(); // ruleVersion 已自增，评论会按新规则重判
}
