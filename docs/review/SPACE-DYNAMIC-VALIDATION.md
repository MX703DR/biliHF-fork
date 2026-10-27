# 个人空间动态兼容验证

日期：2026-10-28。版本：0.0.13。

## 原因与修复

旧版 UserScript 只匹配 www、search、t.bilibili.com，没有 space.bilibili.com，导致空间页根本没有注入脚本，右键与网络过滤均无法启动。新版匹配空间整个域名，而不是仅 /uid/dynamic，以覆盖先打开空间主页再站内切换动态的 SPA 场景；pageType 每次读取当前路径。

原生空间的动态列表使用 dynlist 组件。真实页面渲染表明，发布者名字是 .bili-dyn-title__text 的 span，不是空间链接；单卡 .bili-dyn-item.__vue__.$props.data 则包含原始 modules.module_author。新版优先只读单卡已有数据，复用 normDynamicItem；兼容 Vue 3 props.data，未知结构退回 DOM。不会把正文 @ 链接或转发原作者当成发布者，不读取空间页主人的资料来猜卡片作者。

新版图文 major.opus.title/summary.text、视频附加正文、转发原文均参与关键词判定；动态信息保留 isDynamic，避免把动态作者写成视频 owner。原有 /feed/space 网络过滤共用同一归一函数，仍只删除 data.items 的命中项，不修改签名、请求、offset 或 has_more，不额外补发接口。

## 测试

38 个测试文件、571 个测试通过；typecheck、lint、build 通过。新增入口匹配、SPA 路径识别、两种 Vue props、组件复用、无 UID 时不误读 @、DOM 降级、局部隐藏、空间响应过滤、白名单优先、opus 和视频附加正文等回归。

真实 Chromium 访问空间动态页，游客请求 HTTP 200/code=0 但 items 为空。因此交互验证使用 tests/fixtures/dynamic.json 受控样本响应，让 B 站实际加载的 dynlist 原生组件渲染视频、图文、转发三种卡；不是自行拼装 B 站界面。样本补齐了 visible/basic/module_stat 等渲染字段。GM 存储使用隔离浏览器的本地测试垫片，实际构建产物在 document-start 加载。

验证结果：

- 三种卡均被识别，UID 分别来自单卡作者数据；页面没有作者链接也可按 UID 操作。
- 真实鼠标右键弹出正确作者菜单；Shift 右键未 preventDefault；开启反转后普通右键原生、Shift 右键插件。
- 右键屏蔽图文作者后当场隐藏；刷新后已在响应层移除，未生成该作者的 DOM 卡片。
- 添加“爆料”关键词后转发卡隐藏，刷新仍不渲染；右键屏蔽视频 BV 后刷新无剩余卡片。
- 从空间主页点击“动态”不换文档，原脚本继续工作、只有一个角标；发布者 UID 白名单优先保留命中关键词的视频。
- 1280×720 视口滚轮加载第二页，原生请求 offset 依次为空和 900000000000000001；两页中的受屏蔽作者均未渲染，保留卡正常追加。
- 各交互验证的插件补充请求为 0，页面 error/unhandledrejection 收集为空。没有执行账号黑名单、WebDAV 或其他云端写入。

环境中的 s1 reporter-pb 脚本返回 500，测试仅把它切到同路径的官方 s2 CDN，并在本地应答埋点上报；这些均为测试路由，没有进入发布脚本。游客真实动态内容及真实 Tampermonkey 沙箱/授权弹窗未验证，不能将受控样本验证说成登录账号内容实测。

极高视口下过滤后不足一屏时，原站依赖 scroll 的分页可能没有滚动事件；本次没有为填满屏幕主动轮询或连拉后续页。新增空间域名后，脚本管理器可能要求用户确认访问范围；更新并允许后须刷新已打开的空间页。

## 发布约束

@name、namespace、存储键、updateURL/downloadURL 和产物文件名保持不变。版本递增至 0.0.13；已有配置无需迁移或重新导入。README 不变。
