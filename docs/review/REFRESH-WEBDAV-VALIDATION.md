# 首页刷新与 WebDAV 授权验证

日期：2026-10-06。脚本版本：0.0.11。

## 首页刷新滚动

从游客首页已经加载的原生资源 `index-12fc55c2.js` 定位到两处同步回顶：

- `FlexibleRollBtn` 的刷新点击调用 `window.scrollTo(0, 0)` 后发布 Refresh。
- `RecommendContainer_FloorAside` 接收 Refresh，重置推荐流后再次调用 `window.scrollTo(0, 0)`。

旧版复用完整刷新时继承了这两个行为。旧版在 650px 触发刷新可记录到两次调用，最终回到 0；顶部场景未独立复现用户描述的先下滑过程，因此不将下滑部分归因于某个未经验证的调用。

新版仅在刷新事件的有限分发内屏蔽 `scroll/scrollTo/scrollBy`，不追踪或强行拉回后续滚动、不改 CSS 布局。顶端“换一换”转发到另一个原生按钮，在 `finally` 中恢复方法。直接触发原生按钮时保留当前事件，在下一任务恢复，避免同一元素的 click-in-progress 抑制嵌套 click。恢复保留原属性描述符、继承关系及其他扩展在分发中安装的新方法。

隔离的真实 Chromium 游客首页实测结果：

- 顶部“换一换”使用真实鼠标点击，并启用平滑滚动：243 个逐帧样本均为 0px，无自动滚动调用。
- 中段 650px 刷新：239 个逐帧样本均为 650px，无自动滚动调用。游客环境原生完整刷新入口被原站设为隐藏，此项通过该入口真实 DOM click 触发，没有更改原站可见性。
- 两轮均正常发出 `fresh_type=5&fetch_row=1` 原生推荐请求并返回 HTTP 200，不只是拦截点击。
- 后续鼠标滚轮能从 650px 滚动至 470px；独立“回顶部”按钮仍可返回 0px。
- 未观察到页面错误或未处理拒绝；本插件额外 B 站补充请求为 0。

测试只使用原生推荐请求，不补拉推荐、不调用视频或 UP 详情 API。

## WebDAV 实际只读验证

官方 `@connect` 文档描述按域授权和未知域的确认提示；脚本不能动态替用户批准管理器权限。填写/保存保持本地操作，明确点击“测试连接”才发无凭据的 `PROPFIND Depth:0`，使管理器能对实际目标域名处理授权，再进行带凭据目录读取。已声明坚果云域名，其他仓库仍走按域授权，不声明 `@connect *`。

在真实浏览器加载构建产物、使用实际插件面板的“测试连接”处理函数，对用户提供的坚果云仓库测试：

- 第一次无凭据探测：`PROPFIND Depth:0` 返回 HTTP 401。此处是预期认证挑战，不误报为密钥错误。
- 第二次认证请求：`PROPFIND Depth:1` 返回 HTTP 207。
- 浏览器 DOMParser 正常解析 `DAV:` 命名空间的 `multistatus`；6 个 response，根目录 propstat 状态为 HTTP 200，collection 属性正确识别。
- 面板显示“连接成功，点击‘立即备份’自动创建本插件目录和配置文件”；未发现可选 PiliNara 设备文件，设备列表为 0。
- 没有 MKCOL、PUT、DELETE 或配置文件下载，没有创建或修改任何云端文件。
- 凭据仅临时放在测试进程及隔离页面内存，测试后清除；不写源代码、测试文件、日志、截图或提交。

环境限制：隔离浏览器没有安装真实 Tampermonkey。请求通过限定坚果云地址和 PROPFIND 方法的浏览器特权 HTTP 适配器发送，使用真实 TLS 和响应，插件面板、认证、目录解析均是实际代码；不能据此声称已验证真实油猴的授权弹窗或完全复现用户环境失败。用户侧还可能受已有域名拒绝、浏览器代理/证书或管理器版本影响。

## 本地回归与发布

- `npm run lint`、`npm run typecheck` 通过。
- `npm test`：36 个测试文件、500 个测试通过。
- 防滚动测试覆盖同步调用、异常恢复、继承/getter 属性、只读 API、其他扩展替换、原生点击放行、转发与连点隔离。
- WebDAV 测试覆盖无凭据授权探测、401 可达、授权失败不发送凭据及现有备份/目录/同步回归。
- 构建产物继续使用原更新地址和文件名，版本号升至 0.0.11；README 不变。

参考：[Tampermonkey @connect](https://www.tampermonkey.net/documentation.php?locale=en&q=connect)、[GM_xmlhttpRequest](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_xmlhttpRequest)。
