# WEB 推荐刷新与 PiliPlus 路径验证

日期：2026-10-07。版本：0.0.12。

## 实现依据

重新核对 BewlyCat 当前 main（b004fab5813f81dc85c3bbf76c6fae9d85ac347f）的 WEB 推荐处理：刷新使用 Change=3，下滑使用 DropDown=4，携带 WEB 曝光/点击/uniq_id。它的匿名兜底、App API 和 UI 不采用。本插件调用页面自己的 getHead/getPsParams，签名、登录与会话字段交给原站，不自行选择内容源。

原站 Refresh=5 会同步回顶两次、清空下方列表，再按 document.body.scrollHeight 补到一屏。加载骨架会改变这个高度判断，旧组件的异步分页闭包也不一定立即终止；只在同步 click 内挡住 scrollTo 不足以修复。新版改为 WEB Change 请求后换 key 重建原生分页/哨兵，临时保护跨帧挂载的页面高度与滚动锚定，并在参数推进前阻止过时或空内容的自动分页。

来源：[BewlyCat WEB 请求](https://github.com/keleus/BewlyCat/blob/b004fab5813f81dc85c3bbf76c6fae9d85ac347f/src/background/messageListeners/api/video.ts)、[推荐列表](https://github.com/keleus/BewlyCat/blob/b004fab5813f81dc85c3bbf76c6fae9d85ac347f/src/contentScripts/views/Home/components/ForYou.vue)。原站依据为真实首页已加载的 index-12fc55c2.js。

## 真实首页验证

隔离 Chromium 访问真实 Bilibili 游客首页，构建产物在 document-start 加载，GM 存储由内存垫片提供。开启精确过滤，关闭补充联网取数。

- 1920/1280 两种宽度真实鼠标点击换一换，最终构建分别记录 657/663 帧，位置始终为 0；没有 window 自动滚动调用，旧卡片节点存活数为 0。
- 300/650px 场景打开平滑滚动，通过原生完整刷新入口的 DOM click 验证，分别记录 627/629 帧，位置始终不变；结束后 overflow-anchor/min-height 恢复原值。游客页该完整刷新入口被原站隐藏，没有修改其可见性。
- 所有刷新均为已签名 WEB WBI 请求 fresh_type=3、fetch_row=1，HTTP 200/code=0。后续手动下滑为 fresh_type=4、行号 4/7，正常出现后续卡片。
- 全过滤正则 /./：刷新后仅剩原站登录提示时，静置只有一条 Change 请求；一次向下滚轮只追加一条 DropDown（row=4），无自动补满循环、无插件补充 API 请求。
- 页面 error/unhandledrejection 收集为空；B 站本身存在上报接口错误，未计成插件故障。

边界：未登录，不能声称验证了用户账号的个性化内容或真实 Tampermonkey 沙箱。已用单测锁定原生会话不被插件重置、Request URL/credentials/include/headers 原样保留、无匿名/App 兜底。位置保持样本覆盖顶部与 300/650px；极深位置通过隐藏入口程序化触发全量删除时，新列表总高度不足旧位置，浏览器仍可能自然夹到新页面可滚范围。本次没有用永久空白或自动补拉掩盖这个高度边界。

## PiliPlus 真实文件与界面

路径以仓库根为基准：文件名明确则使用原名；仅目录（包括无尾斜杠）补 piliplus_settings_phone.json。显式路径无需扫描其他目录，保留实际旧文件夹名。跨仓库 URL、路径穿越、编码分隔符、控制字符拒绝。

在真实插件工具面板上，先用内存响应检查共享/独立服务的字段显示与凭据路由：默认隐藏独立字段，关闭时忽略其凭据；开启后只向独立域发送独立凭据。测试前的域名探测不带用户名/密钥，保存不联网。

对用户指定坚果云文件的只读实测发现：HTTP 200、有效 JSON，但实际顶层键是 setting/video/localcache，旧版只识别 localCache，因此读取成功后错误拒绝了结构。新版兼容小写原生缓存与 camelCase；保留原键名，双方去重追加；其他字段只保留原 JSON 文本，不序列化整份文件。

修复后通过实际面板的“测试 PiliPlus 文件”再次读取：完整文件路径和仅目录两种填法均成功识别推荐屏蔽名单。每次都是 PROPFIND Depth:0（无凭据，401）→ GET（认证，200）。不执行 MKCOL/PUT/DELETE，不创建或修改任何云端文件；不公开配置值、UID、用户名、密钥或实际云端目录。

真实 WebDAV 请求通过只允许目标服务根 PROPFIND 和指定文件 GET 的浏览器特权 HTTP 适配器发送，面板、请求构造和解析均为实际构建代码。未安装真实 Tampermonkey，因此不声称验证了管理器的授权弹窗。测试密钥只在临时进程和隔离页面内存中传递，结束后清除。

PiliPlus 不同版本不一定导出屏蔽缓存；缺少缓存时会提示重新备份并拒绝同步，不向未知结构盲写。参考：[PiliPlus 导出逻辑](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/main/lib/utils/storage.dart)、[WebDAV 文件命名](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/main/lib/pages/webdav/webdav.dart)。

## 回归与发布

37 个测试文件、552 个测试全部通过；typecheck、lint、build 通过。涵盖 WEB 请求/会话、旧成功与 62011 错误响应取消、原生分页保护、插件界面输入隔离、组件 key/ref/动态插槽、路径/独立登录/旧存档迁移、两种 cache 大小写、JSON 局部追加与大整数文本保留。产物版本 0.0.12，原更新地址及文件名不变，README 不变。
