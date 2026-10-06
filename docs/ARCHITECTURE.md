# 架构说明 · ARCHITECTURE

> 给**维护者/二次开发者**看的地图：项目怎么组织、数据怎么流、想改某功能该去哪个文件、怎么加新能力。
> 用户向的安装/功能说明在 [README](../README.md)；贡献流程在 [CONTRIBUTING](../CONTRIBUTING.md)。

---

## 1. 一句话

biliHoyoFairy-MX703 是一个净化 B 站推荐流的油猴脚本。源码是 **TypeScript 多模块**（`src/`），经 **esbuild 打包成单文件** `biliHoyoFairy.user.js`（保留原产物文件名与自动更新地址，仓库根，供 Tampermonkey 安装/自动更新）。

**两层过滤模型**（核心心智）：

1. **数据层（主）**：`document-start` hook `fetch`/`XHR`，默认只用响应自带字段和本地被动元数据缓存，在发布响应之前一次性删掉命中项，不为补齐信息额外请求 B 站。缺少标签/分区/简介等字段时保守放行；用户明确开启“允许补充联网取数”后才可按需补齐。首屏 `__pinia` / `__INITIAL_STATE__` 的已知列表先判定、暂缓显示，等原生 hydrate 完成后通过真实 store 提交，避免状态与旧 HTML 错位；搜索的 shallowRef 需重赋根引用。首页原生 Vue 渲染适配在 DOM patch 前过滤推荐 VNode，并把站点自身的隐藏楼层占位转成原生骨架卡，避免加载期间的网格空洞。保留列表数组身份、剩余顺序和分页字段，不改 WBI 参数。
2. **DOM 兜底层（薄）**：新增/复用卡片在 MutationObserver 微任务中判定；未知数据源的异步判定合批提交，新卡在完成前不绘制正文。规则变化只重判已显示卡片，不先把所有隐藏项显示出来。评论隐藏模式过滤响应，折叠/审查模式保留原文并在绘制前处理，以支持手动展开。
3. **同一套规则**：两层共用 `matchRule` + 维度注册表，数据源不同、判定一致。
4. **一键拉黑**：调官方 `relation/modify` 写账号黑名单，刷新后不再被推荐。

---

## 2. 目录结构（每个文件一句话职责）

```
src/
├─ main.ts              入口 bootstrap：装 hook、接线注入 seam、起 scanner、注册菜单（只装配，无业务逻辑）
├─ meta.js              UserScript 头部（@version 单一来源；esbuild 把它 prepend 到产物）
│
│  ── L0 纯叶子（无内部依赖，可独立单测）──
├─ constants.ts         存储键 / DOM 标记属性 / 风控码 / 内置名单（AI机器人、广告正则）
├─ util.ts              纯工具：getCookie / parseDuration / parseCount / escapeHtml
├─ page.ts              页面类型识别 + 「视频卡」选择器 + 网格格子定位
├─ selectors.ts         ★B 站 DOM 选择器登记表（唯一来源；B 站改版只改这一个文件）
├─ events.ts            规则变更事件 seam（onRulesChanged）——打断 dom↔rules 环
├─ presets.ts           预置规则库数据（PRESET_LIBRARY）
├─ shadow.ts            开放 shadowRoot 注册表（评论/卡片穿透用）
├─ gm.ts                GM_xmlhttpRequest 的唯一出口（补 withCredentials 类型；环境不支持时返回 false）
├─ batch.ts             名单批量解析 parseNameList（粘贴的 UID/UP名 → 两组）
├─ json-span.ts         已验证 JSON 的属性值文本定位；PiliNara 旧名单保留原顺序/原名字并末尾追加
├─ webdav-directory.ts  DAV XML 目录解析、仓库 URL 归一化、同源与目录范围校验
├─ match/normalize.ts   文本归一 + 规则行编译 + 作用域关键词 + splitRuleInput（fuzzy 注入）
├─ subscriptions/parse.ts  订阅文本解析（JSON / uBlock 文本双格式）
├─ ui/hooks.ts          UI 回调注入桥（低层模块经它回调面板，避免 import 面板成环）
├─ ui/panel.styles.ts   面板 CSS（import 副作用注入，含暗色 @media）
├─ ui/confirm.ts        样式化确认/输入弹窗 confirmModal/promptModal（替代原生 confirm/prompt；零内部依赖）
│
│  ── L1~L3 状态 / 数据 / 副作用 ──
├─ config.ts            AppConfig 类型 + CONFIG 单例 + 存取/合并/导入导出（deepMerge 原型链防护）
├─ webdav.ts            仓库目录/凭据隔离 + 自动建备份目录 + PiliNara 文件发现与去重追加
├─ metadata-cache.ts    页面原生响应的精简被动缓存：有界、过期清理、跨页持久化，无主动请求
├─ request-budget.ts    补充取数预算：跨页共享 6 次/分钟、60 次/24小时
├─ logging.ts           log / logErr / safe（错误边界）+ BADGE（传函数即惰性求值）
├─ health.ts            运行自检计数器 + healthReport/healthSummary（识别「静默失效」）
├─ cardinfo.ts          卡片信息抽取：DOM(extractCardInfo) 与接口(normFeedItem) 归一成同形 CardInfo
├─ hotsearch.ts         热搜词屏蔽（注入/移除一段 CSS）
├─ stats.ts             拦截计数 + 环形屏蔽记录 + setStatsListener（命中后回调 UI）
├─ subscriptions/store.ts   订阅缓存存取 + collectSubRules（汇总启用订阅）
├─ api.ts              接口层：风控熔断 riskGuard + 限速并发队列 + fetchView/Tags/Card
├─ match/engine.ts     ★匹配引擎：M/ruleVersion + 维度注册表 SYNC_DIMS/API_DIMS + matchRule/matchApi
├─ net.ts             ★拦截层：FEED_HOOKS + NET 管线 + filterFeedJson + fetch/XHR 钩子
├─ net-xhr.ts           XHR 异步响应闸门：DONE/load/loadend 延后交付，支持取消与实例复用
├─ video-filter.ts      统一视频判定：默认本地、可选补齐、8 秒批次期限、版本化结论与迟到隔离
├─ comment-data.ts      评论响应列表过滤：父回复索引、置顶双副本、白名单、保留原始分页
├─ initial-data.ts      SSR 首屏：raw/head、搜索/投稿预览、hydrate 接管、Pinia shallowRef、有界等待
├─ initial-search.ts    视频搜索本地副本：经原生 submitSearch 一次回放同页 SSR 结果，不额外请求
├─ home-refresh.ts      原“换一换”调用 B站原生完整刷新；过时在途批次不能回填
├─ home-grid.ts         原生首页 Vue 渲染适配：DOM patch 前剪枝、原生骨架补占位、规则变更重判
│
│  ── L4~L5 领域 / DOM ──
├─ rules.ts             规则增删统一入口 addToList/removeFromList/pushUnique（改完发 events）
├─ subscriptions/refresh.ts  订阅刷新（联网拉取→解析→写缓存→发 events）
├─ comments.ts          评论区过滤：readCmt/matchComment（纯判定，可单测）+ 折叠/隐藏（DOM）
├─ dom.ts               DOM 兜底层：扫描/隐藏/审查标记/按需联网评估 + rescanAfterRuleChange（扫描**什么**）
├─ scanner.ts           ★扫描调度：document-start 起观察器 + 分阶段合批策略（扫描**何时**）
├─ rulehealth.ts        规则体检：规则集 × 持久化命中计数 → 过宽的 / 从没命中的（判死规则的三条自我约束见文件头）
├─ blacklist.ts         一键拉黑：relation/modify + 联合投稿连带 + 顺序批量(限速+风控暂停)
│
│  ── L6+ UI ──
├─ ui/toast.ts          角标 updateBadge + 轻提示 toast
├─ ui/badge-drag.ts     右下角角标 Pointer Events 拖拽 + 位置持久化与视口边界修正
├─ ui/field.ts          门面 → ui/field/{types,models,list,controls}.ts
├─ ui/listfilter.ts     名单搜索的判定部分（纯函数：普通词=包含、/.../ =正则；与渲染分开以便单测）
├─ ui/menu.ts           门面 → ui/menu/{locate,context,hover,shared}.ts
├─ hide.ts              隐藏/恢复元素的唯一入口（内联 + 原值存档；文档级 CSS 到不了影子树）
└─ ui/panel/            设置面板
   ├─ index.ts          面板外壳：Tab 骨架 + 分区注册表 SECTIONS（数组顺序=显示顺序）+ 开关/重渲
   ├─ ctx.ts            分区契约 PanelSection/PanelCtx（叶子：不 import 任何 section，也不 import index）
   └─ sections/*.ts     分区各自成文件：base / lists / advanced / comment / presets / regex-tester / io
                        / backups / webdav / name-list / subscriptions / batch-block / reset / health / rule-health / log
```

★ = 两处关键设计（匹配引擎、拦截层），改动前务必理解（见 §5 扩展点）。

---

## 3. 分层依赖图（严格自底向上，无环）

每条 import 都指向**更低层**；UI 永远不被低层直接 import（靠注入 seam 回调）。

```
L0 叶子   constants · util · page · selectors · events · presets · shadow · batch · gm
          json-span · webdav-directory
          match/normalize · subscriptions/parse · ui/hooks · ui/panel.styles · ui/confirm
L1        config · metadata-cache（cardinfo 仅类型依赖）· request-budget
L2        logging · health · cardinfo · hotsearch
L3        stats · subscriptions/store
L4        ui/toast · match/engine
L5        api · rules · subscriptions/refresh · comments · rulehealth（net-xhr 无内部依赖）
L5.1      video-filter · comment-data
L5.2      net
L5.3      initial-data · initial-search（回放助手无内部依赖）
L5.4      home-refresh · home-grid
L6        ui/field · blacklist · dom
L6.5      scanner（依赖 dom/shadow/logging；无人依赖它，仅 main 启动）
L7        ui/menu
L8        ui/panel/（index → sections/* → ctx）
L9        main（bootstrap，装配一切）
```

**为什么无环**：原本 `dom↔rules`、`stats→面板`、`toast→面板`、`cardinfo→config`、`normalize→config` 都会成环。统统用「注入 seam」断开（见 §4）。安全网是 `tsc --noEmit`（`src/` 全量类型化后，抽模块时漏 import 会变成编译错误而非运行时崩）。

---

## 4. 注入 seam（理解这 5 个就懂了整套接线）

低层模块需要「回调上层 / 读运行时开关」，但不能 import 上层（否则成环）。做法：低层暴露一个「注入点」，由 `main`（或 `engine`）在启动时塞入实现。

| seam | 定义处 | 谁注册（实现） | 作用 |
|---|---|---|---|
| `onRulesChanged` | `events.ts` | `main.ts` → `rescanAfterRuleChange` | `rules`/`subscriptions` 改完配置只发事件，由 DOM 层重建规则+重扫。**断 dom↔rules 环。** |
| `setStatsListener` | `stats.ts` | `main.ts` → 更新角标 + 刷新面板 | `recordBlock` 记账后回调 UI，stats 不依赖 UI。 |
| `setPanelHooks` | `ui/hooks.ts` | `main.ts` → panel 的 openPanel/refreshPanelIfOpen | 角标点击/放行等低层动作能打开/刷新面板。 |
| `configureFuzzy` | `match/normalize.ts` | `match/engine.ts`（自身加载时） | 把 `CONFIG.fuzzyMatch` 注入纯归一函数，使 normalize 保持纯 leaf。**注意时序：必须在首次 buildMatchers 前绑定。** |
| `configureCardDetect` | `cardinfo.ts` | `main.ts` | 把 `hideAd/hideLiveCard` 开关注入卡片抽取，使 cardinfo 不依赖 config。 |

---

## 5. 扩展点 Cookbook（最常见的"加功能"怎么做）

### 加一个过滤维度（本地，免联网）
改 `match/engine.ts` 的 `SYNC_DIMS` 数组，push 一条 `{ match: (i: CardInfo) => 命中原因 | null }`。`matchRule` 会自动按序短路调用——**这一处加完即在拦截层和 DOM 层同时生效**。

### 加一个过滤维度（需要读接口）
改 `match/engine.ts` 的 `API_DIMS`：`{ source, needs, active, match }`。优先复用原生响应或 `metadata-cache.ts` 的已有字段；本地缓存缺失不能被解释成命中。`needs` 指明字段来源（tag/view/card），`active()` 决定维度是否启用。补充请求另受 `CONFIG.allowMetadataRequests` 的本机明确授权及 `api.ts` 的缓存、限速和预算约束。`apiNeeds`/`matchApi` 自动派生。

### 加一个预置规则
改 `presets.ts` 的 `PRESET_LIBRARY`，加一条 `{ cat, name, desc, rules: { 维度: [...] } }`。面板预置库自动出现。

### 加一个订阅可携带的维度
改 `subscriptions/parse.ts` 的 `SUB_DIMS`（+ 文本前缀表）。`store.collectSubRules` 与解析自动跟进。

### 加一个 feed 接口端点（拦截层覆盖新页面）
改 `net.ts` 的 `FEED_HOOKS`，加一条 `{ re: URL正则, get: (data) => 可过滤数组 }`。

### 加一个配置项
改 `config.ts`：`DEFAULT_CONFIG` 加默认值 + `AppConfig` 接口加字段。旧存档由 `deepMerge` 自动补默认，**纯新增字段无需写迁移、也不用升 `SCHEMA_VERSION`**。面板控件用 `ui/field.bindControl` 绑定。若属「高频后台数据」（每拦一次就变），加进 `config.STATS_FIELDS` 走独立存储键，别让计数器自增去重写全部规则。
只有当老存档需要被**改写**时（重命名字段、改变语义/单位）才升 `constants.SCHEMA_VERSION`，并在 `config.MIGRATIONS` 里加一步 `旧版本号 -> 改写函数`（迁移链会逐级执行到最新版）。

### 加一个面板分区
在 `ui/panel/sections/` 加一个文件，导出 `{ tab, render(host, ctx) }`（`tab` 取 `PANEL_TABS` 的 id），再把它加进 `ui/panel/index.ts` 的 `SECTIONS` 数组——**数组顺序即面板内的显示顺序**。分区只能 import `ctx.ts` 与更低层模块，**不要 import `index.ts` 或别的分区**（会成环）；需要整面板重渲染调 `ctx.rerender()`，需要「面板打开时刷新」用 `ui/hooks.refreshPanelIfOpen`。

### 加一个 B 站 DOM 选择器
一律加到 `selectors.ts`，业务模块从那里 import，别把选择器字面量写在业务代码里。注意：多个候选选择器有**优先级**时（先试 A 再试 B），必须逐个 `querySelector` 循环，不能 `join(',')`——那样返回的是文档序第一个而非优先级第一个。

`closest()` 有同一类陷阱，且更隐蔽：`el.closest('a, b')` 返回的是**最近的祖先**，不是「优先级最高的那个选择器」。`CELL_CONTAINERS`（网格格子定位）就踩过——首页真实结构是 `.container(display:grid) > .feed-card > .bili-feed-card > .bili-video-card`，网格项是外层 `.feed-card`，join 写法会停在更近的 `.bili-feed-card`，隐藏它之后 `.feed-card` 仍占着一个网格单元 → 屏蔽后留下空洞、后面的卡不补位。所以 `cellOf` 按 `CELL_CONTAINERS` 顺序（由外到内）逐个 `closest`；`tests/page.test.ts` 用一个手写的最小 DOM 替身锁住这个语义。

---

## 6. 「我要改 X，去哪」速查

| 想改的东西 | 去这里 |
|---|---|
| 某条规则怎么判命中 | `match/engine.ts`（SYNC_DIMS / API_DIMS）；文本匹配细节在 `match/normalize.ts` |
| 拦截哪些接口/页面 | `net.ts`（FEED_HOOKS） |
| 渲染前的精确过滤 / 超时与结论缓存 | `video-filter.ts`；XHR 事件闸门在 `net-xhr.ts` |
| 首屏 SSR / 首页换一换 / 骨架空洞 | `initial-data.ts` / `home-refresh.ts` / `home-grid.ts` |
| 默认本地元数据 / 补充请求预算 | `metadata-cache.ts` / `request-budget.ts` / `api.ts` |
| 卡片信息怎么抠（标题/UP/UID…） | `cardinfo.ts` |
| 默认配置 / 配置结构 | `config.ts` |
| 设置面板长相/交互 | `ui/panel/sections/*.ts`（骨架与分区顺序在 `ui/panel/index.ts`；样式 `ui/panel.styles.ts`；列表字段组件 `ui/field.ts`） |
| B 站 DOM 选择器（改版失效） | `selectors.ts`（唯一来源） |
| 「脚本是不是失效了」自检 | `health.ts`（面板「工具 → 🩺 运行自检」+ 控制台首屏告警） |
| 右键菜单 / 悬停按钮 | `ui/menu.ts` |
| 一键/批量拉黑逻辑 | `blacklist.ts`（接口层在 `api.ts`） |
| 评论区过滤 | `comment-data.ts`（数据）+ `comments.ts`（纯判定/折叠/审查） |
| 风控/限速 | `api.ts`（riskGuard、队列） |
| 预置词库 | `presets.ts` |
| 订阅格式/刷新 | `subscriptions/{parse,store,refresh}.ts` |
| WebDAV 配置备份 / PiliNara 自动发现 | `webdav.ts`（网络/清洗）+ `webdav-directory.ts`（DAV XML/范围校验）+ `json-span.ts`（名单文本保留）+ `ui/panel/sections/webdav.ts`（交互） |
| 角标/提示文案 | `ui/toast.ts` |
| 启动顺序/事件接线 | `main.ts` |
| 什么时候扫描（首屏不闪 / 滚动节流） | `scanner.ts`（策略 `createScanScheduler` 可单测；扫描**内容**在 `dom.ts`） |
| 规则→原因串 / 原因串→规则 | `match/engine.ts` 的 `ruleKeyOf` / `locateRule`（两侧必须字节一致，`tests/rulehealth.test.ts` 守着） |
| 哪条规则过宽 / 从没命中 | `rulehealth.ts`（读 `CONFIG.ruleStats` × `enumerateRules()`） |
| 名单里搜某条规则 | `ui/listfilter.ts`（匹配语义）+ `ui/field.ts`（渲染；批量操作一律作用于筛出的集合） |

---

## 7. 类型现状

- **`src/` 已全量类型化**：`@ts-nocheck` 为 0，`tsconfig` 开 `strict`。新文件默认受检；`ban-ts-comment` 现在会拦住新增的 `@ts-nocheck`（想整文件关检查得先改 lint 配置，这是有意的摩擦）。
- 与之对应，eslint 里那条给未类型化模块兜底的 `no-undef`（以及 `UNTYPED_FILES` 名单）已删除：同一类错误由 tsc 覆盖，而 `no-undef` 不区分类型位置与值位置，会把 `ParentNode` / `HTMLElementTagNameMap` / `Tampermonkey` 这些只存在于类型世界的名字误报成未定义。
- 几个「一次性收敛」的点，新增代码请沿用而不是各写各的断言：
  - `ui/panel/ctx.ts` 的 `q<T>(root, sel)`：面板 HTML 是静态模板，取不到 = 模板与代码不同步的编程错误，直接抛比 `if (!el) return` 更早暴露（省去约 150 处非空断言，也是 `sections/*` 去掉 `@ts-nocheck` 的主要杠杆）。
  - `gm.ts` 的 `gmRequest()`：唯一的 `GM_xmlhttpRequest` 出口，补上 `withCredentials`（`@types/tampermonkey` 缺）并在环境不支持时返回 `false`——不要再在调用点写 `as any`，那会把整个请求对象的检查一起丢掉。
  - 元素上的附加字段集中声明：卡片走 `cardinfo.ts` 的 `cacheCardInfo/cachedCardInfo`，评论宿主走 `comments.ts` 的 `CommentHost` 接口 + `asCommentHost()`（`Element → CommentHost` 的唯一收窄点）。
  - 事件 target 的收窄用运行期 `instanceof Element`（`ui/menu.ts` 的 `elementOf`），不要 `as Element`。
- 判定与呈现分开导出：`comments.ts` 的 `readCmt` / `matchComment` 是纯函数，可在无 jsdom 的 node 环境单测（`tests/comments.test.ts`）；折叠/隐藏那半不测。新写规则类逻辑请照此切分。
- **lint 不再有整条关掉的规则**（`no-explicit-any` 除外，见下）。迁移期那组「等类型化完再收紧」的关停项已到期兑现。合理的例外一律写成**定点** `eslint-disable-next-line <rule> -- 理由`：关整条规则等于对所有人静默放行，定点豁免只放行这一行且逼你写下理由。目前全仓 3 处。
  - 仍关着的只有 `@typescript-eslint/no-explicit-any`：拦截层要处理 B 站任意形状的 JSON，`any` 是刻意选择，不是欠债。

---

## 8. 构建 / 测试 / 发布

```bash
npm install
npm run build      # esbuild 打包 src/ → 仓库根 biliHoyoFairy.user.js（产物，勿手改）
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest 纯逻辑单测
```

- **改代码只改 `src/`**，别手改根目录 `biliHoyoFairy.user.js`（它是构建产物，CI 有漂移校验）。
- 装油猴测试：`npm run build` 后把根产物粘进 Tampermonkey（详见 [docs/review/SMOKE-TEST.md](review/SMOKE-TEST.md)）。
- 纯逻辑加了就配套加 `tests/*.test.ts`。
- **加了 feed 接口端点（`net.FEED_HOOKS`）就配套加 `tests/fixtures/` 样本**：纯逻辑测试发现不了 B 站改结构，fixture 契约测试（`tests/net.test.ts`）可以。样本请脱敏并裁剪到几条。
- 改了 `src/` 就要升 `src/meta.js` 的版本号（CI 的 `version` job 会在 PR 上强制检查）。

---

## 9. 不变量 / 红线

- 默认不补充请求：开启精确规则不等于授权联网。缺字段时保守放行，等待用户正常浏览产生的原生响应补齐本地缓存；不得自动补足被过滤后的推荐数量。
- 可选补充取数使用 `api.ts` 的 1 并发、至少 1 秒间隔、缓存与风控熔断，另受跨页共享 6 次/分钟、60 次/24小时预算约束。整批最多等待 8 秒；过期或已关闭开关的排队任务不能继续发请求。用户明确发起的账号黑名单操作仍可联网，不能把它当后台自动补齐。
- 元数据缓存最多 1800 项，视频 7 天/UP 1 天过期；只保存白名单字段，不存 Cookie、完整响应、播放进度等个人状态，不进入配置备份。补充取数授权属于 `NON_PORTABLE`，导入/云端恢复不能替用户开启它。
- 超时/熔断的本批结论为临时放行：迟到元数据不能隐藏已经显示的卡片；下一批响应可用新缓存重新判定。配置版本变化不能复用旧结论。
- 首页完整刷新复用 B站 `.flexible-roll-btn-inner` 的原生 Refresh（实测 `fresh_type=5, fetch_row=1`），不复制 BewlyCat UI、不重签/修改请求；该入口缺失时整页刷新。刷新前在途旧批次清空返回列表，防止无限滚动旧结果回填。
- 首页渲染适配只处理已识别的原生推荐组件。保留节点 key、ref、滚动观察锚点和响应式样式，不改全站布局；Vue 编译后的稳定 slot 必须转为动态 slot，避免旧占位被 slot 缓存继续复用。DOM 复用成 skeleton 时只撤销本插件自己的隐藏和标记。
- 自检在原生请求仍在下载或过滤时不得提前报警；真实下载失败、结构失配仍须可观察。

- **不要改 `constants.ts` 的 `STORE_KEY`**（会丢老用户本地配置）。
- 产物**始终输出仓库根**单文件，保 `@updateURL` 自动更新链路；不引入 CDN/远程运行时加载。
- 新增联网维度必须**默认关 + 缓存 + 限速**（防风控）。
- **缓存/存档有界**：API `view/tag/card` 缓存用 `util.capMapSet` 限容；`CONFIG.uidNames` 软上限 5000。任何会随会话无界增长的结构都要设上限。
- **DOM 扫描保留全量兜底**：新增/内容复用节点先窄扫描以赶在绘制前判定，稳态 250ms 全量 `scanAll` 仍由 `PROCESSED` 短路，保障 shadow/skeleton 覆盖；不可只留增量扫描。
- **确认对话框一律走 `ui/confirm.confirmModal`**（Promise<boolean>），不再用原生 `confirm()`；账号写/销毁类操作传 `danger:true`。新增确认入口请沿用，勿引回原生弹窗。
- **账号拉黑必须可撤销**：拉黑成功要给撤销入口（toast 动作 / 屏蔽记录按钮），撤销走 `blacklist.unblockUp`（`relation/modify act=6`）。新增账号写操作同理。
- **自有 UI 配色集中在 `ui/panel.styles.ts`**：新增表面要同时给暗色（`@media prefers-color-scheme:dark`）覆盖，说明性文字保证 WCAG AA（≥4.5:1）。
- `@updateURL` 指向 main = 合入即发布；对外可见改动要 bump `meta.js` 的 `@version`，否则用户不会自动更新。
- 第三方致谢集中在 README，勿散落代码注释。
- **安全红线**（0.0.6 起）：`@connect` 只声明已知域（B 站 + 常见 CDN），不留 `*`；配置**导出与导入都剔除 `NON_PORTABLE`**（尤其 `subscriptions`，防分享文件注入自动联网 URL）；订阅/导入的 `/正则/` 受 `MAX_REGEX_LEN` 长度上限保护（防 ReDoS）。
- **不可信配置必须过 `sanitizeConfigInput`**（0.0.8 起）：导入路径按 `DEFAULT_CONFIG` 的形状清洗，未知键 / 类型不符的值 / 数组里的非字符串元素一律丢弃。它**只用于导入，不用于 `loadConfig`**——`DEFAULT_CONFIG.uidNames` 是 `{}`、`subscriptions` 是 `[]`，拿它们当类型参照会把用户已存的缓存与订阅全部清空。已落盘的坏配置由消费侧的 `match/normalize.ruleLines` 兜底（规则数组的唯一入口）。
- **WebDAV 凭据隔离**：界面仅需仓库目录 URL、用户名、密钥；自动在其下创建 `biliHoyoFairy-MX703/config.json`。地址、用户名和密码只写 `WEBDAV_SETTINGS_KEY`，不得进入 `CONFIG`、普通导出、订阅或远端备份正文；下载的备份与本地文件导入一样，必须先迁移、清洗并剔除 `NON_PORTABLE`。目录发现只允许仓库同源、直接子项，拒绝跨域/越界 DAV href。PiliNara 多设备文件必须选择目标，不自动覆盖第一项。
- **PiliNara 只合并 UID**：写入前读完整文件，以远端 `localCache.recommendBlockedMids` 为基准去重并在末尾追加缺少项；保留原名单的文本顺序、名字及未知项，其他配置语义不变。没有新增项就不 PUT；有 ETag 时用 `If-Match` 防止并发静默覆盖；不能把 BV/AV 或账号 `blackMids` 写进推荐名单。
- **账号写操作红线**：单条拉黑（右键/悬停）执行前必须二次确认；批量拉黑必须可停止、限速、风控自动退避；`doBlacklistMany` 批量本地屏蔽统一一次 `saveConfig+emitRulesChanged`（勿逐条重扫）。
