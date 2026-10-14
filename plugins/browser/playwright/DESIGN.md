# 外部浏览器连接

该包拥有一代插件的外部浏览器连接，以及通过它创建的隔离 context。部署方拥有浏览器进程。
仅提供 `PlaywrightPlugin.newContext(options?, { signal? }?)`；返回原生 SDK，不创建平行 Page/Locator API。
不暴露默认 context，不接管其它客户端已有的页面，不内置任务队列、站点动作或浏览器安装器。

## 所有权与停止

初始化完成所选协议的握手后插件才进入可用状态。provider generation 持有 Browser，caller Context 持有自身 context 与获取任务。
原生 context 的 close 事件撤销登记。caller 停止中止其获取等待、关闭其 context 并 drain 迟到获取；provider 停止关闭已创建 context、断开 transport，再 drain 获取。
provider 自己的调用共用 generation cleanup，不另登记一个会阻止断开连接的 owner cleanup。
不主动重连。断开事件使后续获取拒绝，显式重启重新建立连接。

`playwright-core` 1.64.0 的 `lib/coreBundle.js` 中，CDP 的 `_connectOverCDPImpl` 将 `browserProcess.close` 和 `kill` 指向调用 WebSocket transport `closeAndWait()` 的函数；原生协议连接将 `_shouldCloseConnectionOnClose` 置为 true，`Browser.close()` 据此调用客户端 `_connection.close()`。
两种连接产生的 `browser.close()` 都断开当前 transport，不终止部署方的浏览器进程。升级 SDK 时需复核该语义；实现未使用内部 SDK import。
公开语义也见 [Browser.close](https://playwright.dev/docs/api/class-browser#browser-close)。
CDP 连接使用 `noDefaults: true`，避免连接时自动修改远端默认 context 的 focus/media/download 设置。

SDK 的 `newContext` 与 `context.close` 无请求级取消/超时。AbortSignal 取消等待，底层获取仍由 owner 跟踪，晚到 context 必须关闭。
caller 的停止等待它完成；不为单个 caller 杀死共享 transport。远端持续不响应会阻塞停止，这是共享原生 SDK 路线的公开限制；不以裸超时放弃资源冒充成功清理。

## 配置与凭据

公开 `PlaywrightConfig` 与插件 `configs.use()` 使用同一个 schema；互斥 endpoint / connectionKey 在 schema 校验。
`protocol` 默认 `cdp`，通过 `chromium.connectOverCDP` 连接；显式 `playwright` 使用 `chromium.connect`。同一 context API 与 lifecycle 沿用不变，不引入平行 provider。
CDP 接受 HTTP(S)/WS(S)，原生协议仅接受 WS(S)；普通配置在 schema 校验，Vault 记录在启动解析后复核所选协议。
协议由部署方声明，不通过失败重试猜测；原生协议连接要求服务端与客户端 major.minor 匹配，依赖版本升级由宿主工作区管理。
没有凭据时不需要 Vault 服务。凭据通过 `PlaywrightVaultSchema` 的 owner namespace 记录绑定，启动时校验；不观察自动轮换，更新后重启。
普通 endpoint 拒绝 userinfo、query 和 fragment；路径可能也包含 secret，部署方必须把这样的 URL 放在 Vault。
SDK 连接错误可能包含 endpoint / headers，初始化统一抛安全消息，不保留原始 cause。业务阶段原生 SDK 错误保持原样，调用方投影到日志/HTTP 时自行选择安全字段。

## 证据

真实 test host 驱动 lowering、config、依赖 facade、caller stop 和 provider stop；SDK mock 仅控制 remote 资源时序。
覆盖初始化失败/部分获取回滚、Vault部署绑定、不接管默认 context、手动关闭、晚到获取、取消、断开、原生异常与 secret-safe lifecycle report。
外部 Chromium / Lightpanda 协议兼容性仍需真实 endpoint 测试；不以 mock 宣称可在线查验票据。
