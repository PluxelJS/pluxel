# 联网与能力可观察性

状态：演示主路径已实现；真实 HTTPS/Wretch/owner 观察已验证，完整双环境故障与流清理矩阵仍待补，准确进度见 [IMPLEMENTATION](IMPLEMENTATION.md)。沿用 [DESIGN](DESIGN.md) 的所有权、会话和 HMR 语义。运行时复用路线与证据由 [RUNTIME](RUNTIME.md) 拥有；本页拥有联网的 Pluxel 集成和能力观察。不自行实现标准 Web API。

## 1. 复用运行时 Fetch 与 Wretch

确定内嵌 LLRT。开发使用 Node Fetch，发布使用 LLRT Fetch；两端标准实现可以不同，但同一业务、取消和响应语义必须通过测试。窗口、剪贴板、存储等应用特有能力仍访问真实原生应用，网络响应 body 不经 应用 JSON bridge 搬运。

```text
RemoteLookup Plugin
  -> 上游 wretch，注入 owner-bound fetch
  -> SDK Network Service（归属、生命周期、观察）
  -> 开发：Node Fetch / 发布：LLRT Fetch
```

拟议写法，不是已实现 API：

```ts
import wretch from 'wretch'

const network = this.ctx.require(Network)
const api = wretch(baseUrl).fetchPolyfill(network.fetch)
const body = await api.get('/lookup?q=example').json()
```

Network Service 接收执行环境已提供的 fetch，固定 owner 后发放函数；缓存、派生 client 和脱离 receiver 不改变归属。它不实现 Headers、Request、Response、AbortController、URL 或 Streams，也不通过可变“当前插件”来识别异步调用方。

[上游 Wretch](https://github.com/elbywan/wretch) 的准确 API 按工作区版本核对。仓库 [@pluxel/wretch](../../docs/plugins/wretch.md) 是另一层 provider，当前 [主入口](../../plugins/wretch/src/index.ts) 含 Node/Workbench imports 且要求 Persistence；不能因有 Fetch 就宣布整个 provider 已移植。首次用上游 wretch，后续必要的 portable 修复归原包，不复制实现。

## 2. 标准兼容与生命周期是两个边界

Fetch 及相关对象由成熟 runtime 提供，以 [Fetch Standard](https://fetch.spec.whatwg.org/) 和真实包测试验证。不为了简化演示主动砍掉 Blob、FormData、Streams 或全局 fetch；所选版本有缺口时记录并采用有界上游修复；必须处理 RUNTIME 中已确认的上传和 Origin 缺陷后才能宣称相应支持，不用假 Response 或空 shim 掩盖。

第一阶段涵盖 Request/Headers、HTTP 状态、JSON/文本/二进制、bodyUsed/clone、流式 body、FormData、URL、AbortSignal.any/timeout 和 WebCrypto 的已选算法。HTTP 404/500 返回 Response，网络/TLS 失败 reject；headers 可用和 body 完成分别验证。兼容矩阵和代表包清单见 RUNTIME，不声称已完整通过标准测试。

owner-bound 请求合并请求自身、owner 和超时 signal。stop/HMR 后旧 fetch 拒绝新接纳，未结束 IO 收到 abort。只等 fetch Promise 不能证明 body drain，Service 需要跟踪响应 body 的读取或显式取消；优先使用既有资源/Streams 接口并验证 upstream abort 后的关闭，不自建 stream 实现。无法确认 drain 时诚实报告缺口，不能宣称 teardown 完成。

全局 fetch 留给第三方兼容，但它无法自动获得可靠的单插件归属。首版不修改整个 Node/Vite 进程的 globals，不禁止仅依赖全局 Web APIs 的包。全局调用记为未归属（没有全局观察覆盖时显示未观测），也不承诺 stop 某插件即可取消它。需要严格 owner 生命周期的插件必须注入 Service fetch 或将库自身的 cancel/dispose 接入 effects。

## 3. 应用策略与真实限制

应用配置通过同一个 Network Service 契约传给两端。并发、排队和请求超时在 Service 接纳点拥有；HTTP/TLS/重定向执行归运行时。不要同时在原生应用、Service 和 provider 各自维护一份不一致的网络策略。

origin 限制如果启用，必须覆盖每个 redirect hop，不能只检查初始 URL。优先使用 upstream 可用的请求/redirect 控制点；不存在时先拒绝自动跳转或标明该策略不支持，不能用修改 response URL 假装已阻止访问。cookie、代理、CA/TLS 和认证分别核对 Node/LLRT 的实际行为；应用不默认把主应用凭据交给插件。

标准全局 fetch、runtime 自带文件/进程 API 与同 realm 对象意味着 Service 策略不是恶意插件安全边界。能力观察和受控示例可继续实现，但不能宣称所有出口都已拦截或可按插件授权。LLRT 的 Node/进程等系统 API 的暴露需要在嵌入阶段核对并明确记录。

consumer 决定业务重试/缓存/去重。每次 retry 经过 owner-bound Service 单独计量，POST 不因断连自动重放。响应读取预算和 body 资源要在真实读取路径验证；不能为精确统计偷偷提前消费或复制整份 Response body。

## 4. 能探测到哪些能力

管理页必须区分事实来源，不能把一个模糊的“权限列表”同时用于声明、使用和授权：

| 事实 | 可从哪里取得 | 能证明什么 |
| --- | --- | --- |
| 已安装的 Host 能力 | 应用装配与 capability descriptors | Host 提供哪些 Services，不证明某插件使用过 |
| Plugin required/optional 依赖 | 现有 lowering 与 inspect dependencies | 对其他 Plugin 的声明关系，不是完整 Service/IO 清单 |
| 显式能力需求 | 拟议包内声明，经构建校验 | 作者声明需要哪些应用能力，不证明实际调用 |
| 静态发现的调用 | 对直接 token import、ctx.require 和已知方法的分析 | 有来源位置的已知引用；动态调用、封装和间接依赖可能未知 |
| 已取得能力句柄 | owner Service 创建/发放处 | 此 owner 曾取得句柄，不代表执行过副作用 |
| 实际调用/活动资源 | Service 接纳与 native backend 回执 | 受观测入口中的调用、完成、失败、取消和活跃资源 |

当前 [inspect](../../docs/development/inspection.md) 没有完整的“插件所有能力使用扫描”契约。首版直接做 Service 运行时观察，显示“本 session 已观察”，不实现通用静态分析器，也不扩展全局 Plugin ABI。未来显式需求声明如果用于权限接纳，需要独立定义其 owner 和授权语义，不能把猜测的 import 清单当授权依据。

依赖链中的归属需要诚实：consumer 调用 provider，provider 用自己缓存的 Network 句柄联网时，资源 owner 是 provider；只有现有 caller-bound 调用确实提供 caller context 时，才能另记调用方。没有明确因果上下文就显示未知，不将所有下游 IO 归给最外层插件。Part 保留 occurrence path，但资源寿命仍从属于 owning Plugin generation。

首版原生管理页为每个 Plugin 显示能力名、取得/调用状态、最近结果、次数、活跃请求/订阅数量。网络只记录 origin、method、状态、耗时与字节数，默认不记录 query、headers、body、剪贴板内容或令牌。数据有界且随 session 标明范围；卸载/停用后的历史与当前活动资源分开。

遥测由 Service/backend 产生，独立投影给管理页；观察器失败不改变业务成功结果。关闭详细记录仍保留执行必须的 owner/lifecycle 检查。不要为“自动发现一切”给所有 Context 成员套通用 Proxy。

## 5. 其他范式与最小演示增量

| 范式 | 代表路径 | 演示价值 |
| --- | --- | --- |
| 纯计算与多入口 | Calculator -> Launcher/CLI | DI、共享业务、配置 |
| 原生短副作用 | Clipboard/Desktop | 原生调用回执，取消不回滚 |
| 订阅与贡献 | 查询 provider/动作 | 注册撤回、HMR 和晚到消息 |
| 出站异步 IO | RemoteLookup -> Wretch -> Network | 超时、取消、错误转换、能力观察 |
| 持久设置 | Host storage + config | 保存/应用分离，跨 runtime 保留 |

新增一个 RemoteLookup 插件即可：向配置的 HTTP(S) JSON endpoint 查询少量匹配项，通过 schema 验证后显示原生结果。它不自动查询用户每次输入，使用明确前缀或动作触发，避免无意把所有输入发送到网络。配置只包含 endpoint 和展示所需参数，初版使用无需凭据的服务。

自动化使用可控 HTTP 测试服务器覆盖慢响应、错误和重定向；手动演示另调用真实网络 endpoint。两者分别通过实际 Node 和嵌入 LLRT 网络实现验证，不以 mock fetch 代替；还要对配置的真实 endpoint 做手动联网验证。正常查询、断网、stop/HMR 期间的请求取消、owner 统计和重新启用后恢复是新增验收项。

凭据保险库、任意文件系统访问、后台 cron、WebSocket、流式 SSE 和进程执行暂不新增。未来按真实需要接入对应能力；不同取消和资源语义不藏进一个万能 `invokeNative` 方法。

## 6. 实施顺序与验收补充

在原生异步 bridge 与 HMR 基础闭环之后、最终发布验收之前完成此模块：先复用运行时 Fetch 完成一个真实请求，再实现 Network owner 生命周期、Wretch、RemoteLookup 与能力投影。构建先检查 SDK globals/依赖闭包，联网能力不绕过原来的 QuickJS 阶段。

必验：200/404/500、无效 JSON、DNS/TLS 失败、headers 后延迟 body、body 二次消费、clone、请求前/读取中取消、超限 body、重定向至不允许 origin、HMR 中断请求、旧 fetch/client 拒绝新调用，以及 consumer/provider 的正确归属。重试分别计量，未知结果不自动重放。开发与发布使用同一输入场景核对结果；只有 Node 成功不能标为 Fetch/Wretch 已支持。
