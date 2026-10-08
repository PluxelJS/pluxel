# 运行时决策与验证证据

研究日期：2026-10-08。**选 LLRT，优先插件作者使用 npm 生态的成本，而非主应用语言或商业背景。** txiki 不作为第二条实现路线。技术栈见 [STACK](STACK.md)，本页拥有证据、缺陷与嵌入门槛。

## 1. 结论与边界

两者都能运行样本中的现代 Web/纯 JS 包。LLRT 额外提供部分 Node 工具 API，且本次 Fetch 行为探针通过更多，因而更可能减少插件适配。不等于任意 npm 兼容、长期更稳定或嵌入 SDK 更成熟。

txiki 的标准 WebCrypto 覆盖多种 AES、RSA、EC、HMAC、密钥派生；不用学 tjs API 才能加密。不能用不存在的加密短板支持选型。[txiki Crypto](https://github.com/saghul/txiki.js/blob/v26.6.0/src/js/polyfills/crypto/subtle.js)、[LLRT API](https://github.com/awslabs/llrt/blob/v0.9.0-beta/API.md)。

LLRT 官方仍标注 experimental。其 WPT 子集/预期失败基线、txiki 跨平台/Sanitizer/GC stress 都不等于完整标准符合性。[LLRT WPT](https://github.com/awslabs/llrt/blob/v0.9.0-beta/tests/wpt/README.md)、[txiki CI](https://github.com/saghul/txiki.js/blob/v26.6.0/.github/workflows/ci.yml)。

## 2. 同条件实测

Linux x64，Node 24.16.0；LLRT 官方 v0.9.0-beta Linux x64 no-sdk 二进制；txiki v26.6.0（1a230d31183f062fae7a6c4fd2cff466cecc1787）及固定子模块，默认 CMake Release 构建，上游源码无修改。三者使用相同 esbuild 0.28.2 browser/ESM/es2022 bundle、依赖锁、真实 HTTP echo server 与断言，无专属兼容补丁。

| 场景与版本 | LLRT | txiki |
| --- | --- | --- |
| zod 4.6.5 + yaml 2.9.1 + semver 7.8.5 解析校验 | 通过 | 通过 |
| noble ciphers/hashes 2.4.0：AES-GCM 往返、SHA256 | 通过 | 通过 |
| jose 6.2.12：HS256 JWT 签验、A256GCM JWE 往返 | 通过 | 通过 |
| wretch 3.0.9 JSON POST | 通过 | 通过 |
| axios 1.20.0 browser 默认 adapter JSON POST | 通过 | 通过 |
| wretch / 直接 Fetch 上传 Blob 文件 | 失败 | 失败 |
| fetch URL 对象、取消原因保留、Response.clone 双读 | 三项通过 | 三项失败 |
| Symbol.dispose / asyncDispose | 存在 | 存在 |
| Pluxel 空 Host start/status/close、Commands 空 registry | 通过 | 通过 |

Node 对照全部通过。12 个 portable 探针 LLRT 10 过、txiki 7 过；上传测了库和直接调用两条路径，不能算两个独立缺陷，也不能将计数解释为 npm 兼容率。空 Host 使用当时工作区 Host/Commands 源码和已有依赖制品，不是干净重建全仓库。

临时复跑材料在 /tmp/pluxel-runtime-research-J3zE7X/：run.mjs、portable.mjs、node-apis.mjs、pluxel.mjs、package-lock.json、comparison-results.json。目录可能被清理，不是构建依赖或交付测试。实施时重建项目内正式探针、记录实际产物，不将临时成功继承为新版本的验证。

研究探针当时未验证：真实 LLRT 嵌入、正式 lowering 插件启停/配置/DI、Commands service/mount、UI、HMR、JSRuntime 重建、HTTPS/TLS、完整包功能、性能与长期稳定性。后续实施证据单独维护在 [IMPLEMENTATION](IMPLEMENTATION.md)，不混入这张原版 runtime 比较表。

## 3. 限制与已知缺陷

LLRT 实测 createHash/createHmac 正常；createCipheriv/createSign/pbkdf2/scrypt、util.promisify/callbackify、AsyncLocalStorage、fs.realpathSync 不存在。txiki 无法加载探针中的 node:crypto/util/async_hooks/module/stream/fs。模块存在不代表其中常用方法完整。

LLRT 内置 AWS SDK 经过 browser 构建和 shim/alias，不是未经适配支持任意 SDK 的证据。[构建配置](https://github.com/awslabs/llrt/blob/v0.9.0-beta/build.mjs)。

| 缺陷 | 证据与处理 |
| --- | --- |
| LLRT Blob -> FormData 内容损坏 | hello-file append 后成为十进制字节数字串；File::from_bytes 错用 Blob parts，研究时 main 也存在。冻结发布版本前修复，补非 ASCII/二进制回归，不让插件作者绕开标准路径。[源码](https://github.com/awslabs/llrt/blob/v0.9.0-beta/modules/llrt_buffer/src/file.rs#L112) |
| LLRT Fetch 自动 Origin 影响 OAuth | v0.9.0-beta 有该逻辑，研究时 main 已移除。锁定修复 revision/补丁，验证真实请求头；不是升级 main 就消除其他缺陷。[上游问题](https://github.com/awslabs/llrt/issues/1792) |
| txiki Fetch 语义缺口 | 完整 runtime 复现文件变 URL-encoded [object File]、URL 入参失败、取消原因丢失、clone 流冲突。只保留比较证据，不维护第二套修复。[Fetch](https://github.com/saghul/txiki.js/blob/v26.6.0/src/js/polyfills/fetch/fetch.js)、[Body](https://github.com/saghul/txiki.js/blob/v26.6.0/src/js/polyfills/fetch/body.js) |

优先使用上游已修 commit，否则保留小而可审查的补丁及测试，不复制标准 API 到 SDK。修复后的精确组合才是发布基线；v0.9.0-beta 只是研究基线，不是无条件通过的版本。

## 4. 嵌入门槛

实施期补充（2026-10-08，阶段状态仍以 [IMPLEMENTATION](IMPLEMENTATION.md) 为准）：真实嵌入已暴露 timer callback 抛错会结束 LLRT timer loop，后续定时器无法执行；`RT_TIMER_STATE` 注册表也缺少 runtime 销毁时的移除。两项已由项目有界补丁修复，并在实际链接 runtime 的异常、后续定时器执行与重复销毁计数回归通过；不从 CLI 探针或普通关闭成功推断无泄漏。补丁来源与移除条件由 [补丁说明](patches/README.md) 维护。

[LLRT Vm](https://github.com/awslabs/llrt/blob/v0.9.0-beta/llrt_core/src/vm.rs) 暴露 AsyncRuntime/AsyncContext 和 ModuleBuilder，但初始化/run/spawn 错误可能退出进程，默认 loader 带当前目录、/opt、Lambda 路径，HTTP/security 有进程级初始化。不能直接搬 CLI runner，也不能仅凭 Rust 断言桥接优雅。

阶段 A 必须证明：

1. Rust 程序实际链接 LLRT，注入私有 module，JS 异步调用原生后 Promise 完成；不启动 llrt 子进程冒充嵌入。
2. 保留标准库装配，loader 只读固定共享模块和 active 集合；全局初始化按上游契约执行。裁剪 feature 后重新跑兼容，不继承完整 CLI 结果。
3. 插件异常、未处理 rejection、初始化失败不得退出主应用；process.exit 等显式进程控制入口同样审计并定义行为。这不是恶意插件隔离承诺。
4. 专用线程 executor 推进 JS 与消息；跨线程唤醒和取消有效，不同步重入，不向 UI 传 JS 值。
5. 同 runtime 内真实插件 stop/start/config；executor 存活时 close Host，再释放 handles、销毁。带请求、timer、回调的重复重建无资源计数累积。

桥接不自动提供 Plugin 归属，owner-bound Services/effects 才拥有归属和撤回；协议细节见 DESIGN 与 NETWORK。

## 5. 发布兼容合同

目标为纯 JS/Web API 包，加已验证 Node 工具 API。构建记录包版本、exports 条件、残留 imports、runtime revision 和测试场景。不能选 browser 就假设无 DOM，也不能让未知 node:* 静默降级。保留标准 globals，不强迫插件使用 llrt:* 专有 API。

包可加载与生命周期可管理是两项验收。直接 global fetch 不自动有单插件归属；严格 stop/HMR 清理须注入 Service fetch 或将库 dispose 接入 effects，见 [NETWORK](NETWORK.md)。

实际嵌入产物重跑本页探针，并补 mathjs/number、完整 Plugin graph/config/Commands、Fetch body/timeout/TLS/错误、发布 loader。样本不要求全部成为演示业务依赖。

不承诺任意 Node API、.node addon、DOM、V8 行为或完整 WPT。若核心示例必须靠持续补造 Node 才能实现，报告具体阻断并重新讨论边界；不暗换 Node 发布后端，不无限扩大补丁。当前选择 LLRT，不循环枚举候选。
