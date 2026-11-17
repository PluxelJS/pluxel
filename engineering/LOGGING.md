# 日志：身份、策略与有界读取

Core 拥有日志安装、身份、动态 policy 和 bounded store，Management/Workbench 读取同一个 manager。作者调用见[日志指南](../docs/plugin-development/logging.md)，原生配置见 [Host logging](../docs/host/configuration.md#host-logging)。

## 模型

`RuntimeLogging` 拥有 rootId、LogTape configuration、plugin policy、debug matcher、持久化和 stores；`ContextLogger` 固定 Context identity/properties 并委托 LogTape。

进程同时只允许一个 active logging root。重复安装或 foreign LogTape configuration 会拒绝，失败候选保留原 owner。active-root filter 拒绝旧 Context/错误 rootId 的记录。Host 关闭负责 flush/dispose。

## Category identity

路由身份位于 category，不依赖可覆盖或 lazy 的 properties：

```text
runtime        ["pluxel", "runtime", rootId]
plugin         ["pluxel", "plugins", rootId, ...v1NodeRouteSegments]
runtime debug  ["pluxel", "debug", rootId, "runtime", ...topicSegments]
plugin debug   ["pluxel", "debug", rootId, "plugin", ...v1NodeRouteSegments, ...topicSegments]
```

`v1NodeRouteSegments` 由 Core `formatPluginNodeRoute()` 产生，例如 `v1/fork/east/package/OrdersPlugin/@acme/orders`，可逆且不含物理路径/digest。displayName 和 properties.context 只用于展示/查询。with() 或单次 properties 不能改 root/plugin identity 和 debug topic。codec 位于 `packages/core/src/logger/categories.ts`。

## ContextLogger

`LoggerService` 按 Plugin Context 隔离，首次读 ctx.logger 才创建 view，不共享可变 current Context。六个 level method 在 prototype，category 和 LogTape view 各创建一次；getDebugChannel 不维护 topic cache，长期复用由 caller 保存返回值。

root WeakMap 保持稳定 identity，配置前创建的 logger 在安装后继续使用它。author facade 不捕获 caller stack；当前 manager guard 拒绝 foreign/retired root。实现位于 `packages/core/src/logger/LoggerService.ts`。

## RuntimeLogging lifecycle

`runtime.logtape` 接收原生 Config、同步 root factory 或 `{ input, options }`。可选 `logtape(nativeConfig, options)` helper 捕获相同声明，无品牌准入。省略配置不安装 manager，ctx.logger 仍可调用；silent manager 显式使用 `logtape({ sinks: {}, loggers: [] })`。

```text
root/logger identity → Core prepare 安装 LogTape → 恢复 policy
  → 其余服务/Plugin graph
关闭：Plugin/effects → store/policy/native sink flush/reset → TinyBase → FS
```

Host 自动等待 Core prepare；Core-only 嵌入者启动 Plugin 前等待 `prepareCoreContext(root)`。安装前日志不由本次 sink 捕获。安装、policy 和关闭都归 Core。

## Native LogTape configuration

原生 `Config<string, string>` 保留 sinks、filters、loggers、contextLocalStorage、parentSinks、captureSourceLocation 和对象 identity；sink/filter/formatter 按上游执行。LoggingOptions 只补充 profile、初始 Plugin policy、debug topics、policy load failure 和借用 policy store。

同步 config factory 在 prepare 求值一次，额外取得 rootId 和 createRuntimeLogSink()；后者只在 factory 执行期创建绑定本 manager 的 bounded sink。

`logtape()` preset 提供易读 console、有界 store，默认 profile 为 pluxel；console 过滤 info，store 接收 trace。servicesPreset 不安装日志。自定义配置完整替换预设，file/JSON/OTel/redaction/stream 使用上游 sink/formatter。未选择 store 时不分配 registry，显式访问 stores 才惰性创建。

### Identity guard and native inheritance

框架添加一个 native guard filter：缺少根 logger 时补最小根配置；已有根 logger 保留字段并把 guard 置首。其他非空 filters 前补 guard，省略/空 filters 保持原状，以保留最近非空祖先 filter 的继承/替换规则。guard id 避开用户名称。

guard 仅处理 pluxel/runtime、pluxel/plugins、pluxel/debug：校验身份、动态 policy 和 topic；应用/其他库类别直接通过。用户 filter 随后执行，级别、sink 继承、parentSinks: forward 和 source location 仍归 LogTape。

默认 store 在 guard/native filters 后才丰富 caller。用户启用 captureSourceLocation 时，上游按自己的阶段取 stack；lazy() 保留昂贵属性的原生行为，properties factory 可能早于 filter 执行。

### Resource ownership

RuntimeLogging 拒绝 `reset: true`，防止接管 foreign owner；其他原生字段保留，引用、重复 category 等错误由原生 ConfigError 报告。

flush() 保存 bounded store/policy 并调用 native drain()，仅 Drainable sink 参与。dispose 等待在途安装，包括 config factory 内重入关闭，然后 flush/reset。flush/drain 失败仍继续释放全部同步/异步 sink/filter，错误聚合。关闭期间持有 owner 并拒绝重装，只有全局 configuration 仍为自己安装的对象才 reset；foreign replacement 报错并保留它。并发 dispose 共用 Promise。

OTel 直接组合原生 sink 和 SDK，见[远程输出](../docs/host/configuration.md#远程输出原生-logtape-sink)。其 sink 无 native drain，立即发送用 provider.forceFlush()，Host close 经 async disposal 等待 shutdown；`tests/logging/otlp.test.ts` 覆盖 HTTP JSON/protobuf、关闭日志和 prepare rollback。

## Dynamic plugin policy

v3 policy 使用 structured node owner、default/override level（含 off）。热路径在 rootId 检查后，对 canonical owner rank 做一次 Map.get 和数值比较，不读 properties、生成 snapshot 或重新 configure。

首次 category 严格解析 route，immutable category/address 用 WeakMap 缓存，mutation 替换 rank cache。稳定流不重复 decode/hex encoding，缓存不保活 logger/Plugin。native threshold 是静态下限，policy 是动态下限；需从 UI 调整 trace 到 off 时，接收 Plugin 日志的 logger/store 应接收 trace。

- default/plugin set/clear 为 O(1)，回执为 `{ revision, persistence }`。
- getPolicy/reset/replace/persistence snapshot 为 O(N)。
- RPC expectedRevision 防止并发覆盖；保存串行并合并中间状态。
- 最多 100,000 个 overrides，owner 严格校验；off 使用独立 numeric rank。

policyStore 是同步 `(root: RootContext) => PluginLogPolicyStore` factory，日志 prepare 时求值一次；默认借用 `services/host/logging/plugin-policy/<profile>.json`。Logging 拥有 candidate/失败回执，[FS](FS.md) 拥有文档 IO/final drain，借用 backend 不由 Logging 关闭。

删除 fork 在同一 Host exclusive queue 先清理日志 policy，再清理服务 metadata；policy flush 失败保留 fork。writer 故障需关闭并检查 backing 后恢复。reader/writer 只接受 v3，不转换或写回旧格式。

## Debug topics

patterns 在 manager 创建时编译：`hmr:batch` exact，`hmr:*` prefix，`*` 全部，空数组关闭。最多 256 条，topic 最多 16 段、每段 80 字符。matcher 直接比较 category segments。

Plugin debug 同时经过 active root、Plugin policy 和 root debug matcher；off 关闭普通日志及 debug。

## Runtime store

store 为 Management/Workbench 提供有界读取，policy 独立存储。RuntimeLogging registry 默认最多 64 个 physical streams，非 default stream 按无 subscriber LRU 淘汰。每 store 使用 1024-line chunks 和 bounded retention，buffer、flush interval、payload、hidden/redact keys 均有上限。

Plugin address 从 category 解析，structured plugin filter 接收 PluginNodeAddress。仅非身份用途的 `context:<name>` virtual stream 复用 default physical store。range/latest/wait/follow(observer) 使用同一 RuntimeLogStore。

Workbench range/follow 经过页面唯一的已认证 Runtime session；generation-scoped ElysiaApp 是业务 ingress，不拥有日志 store 或管理 principal。长期归档使用 file/OTel sink。RuntimeLogLine 是保留 category、identity、structured message、props、error summary 的 transport/UI 投影。

## 性能验证

guard 不做 caller capture、properties 求值、snapshot、序列化或 IO；单 owner rank lookup 为 O(1)。snapshot/reset/replace/persistence 显式 O(N)。`packages/core/bench/logger.bench.ts` 对比普通与 100,000 overrides hit 的规模趋势。

## Package boundaries

| 入口                | 所有内容                                                          |
| ------------------- | ----------------------------------------------------------------- |
| `@pluxel/core`      | ContextLogger、LoggerService、category identity、纯 Plugin labels |
| `/config`           | logtape/zenfs 代码配置 helper                                     |
| `/logging`          | Logging token、manager、policy、stores/query                      |
| `/logging/protocol` | browser-safe DTO/filter                                           |
| `/logging/internal` | 安装、active owner binding、framework helper                      |
| `/logging/pretty`   | 可选 console 展示                                                 |
| Host/Services       | 应用 lifecycle、Management 投影                                   |

配置 helper 不依赖 Host/Services；Management 读取既有 manager。protocol 不加载后端，pretty 为独立叶入口，file 输出直接使用 @logtape/file。public Logging token 解析当前 owner，manager 创建和 binding 留在 internal。

关键代码为 Core `logger/{LoggerService,categories}.ts`、`logging/{logging,policy,sink,store}.ts`；管理投影为 Services `management/services/management/RuntimeManagementTarget.ts`。

## 验证

回归入口为 `packages/core/tests/logging/`。identity/lifecycle 覆盖 active/foreign root、Context 缓存归属、失败安装保留 owner、关闭 flush；policy 覆盖 revision、并发、串行保存；store 覆盖 retention/gap/epoch 和 bounded follow。

`native-config.test.ts`、`native-config.typecheck.ts` 覆盖原生继承、contexts、Node caller、drain/async disposal 和 foreign owner。区分框架 guard 不取 caller/properties 与上游显式配置的实际执行时机。成本变化使用[性能探针](#性能验证)。

## Trusted development scripts

Script SDK 的 sdk.logs 委托本领域 markLogs/readLogs/waitForLogs；也可经 `sdk.ctx.require(Logging)` 访问 manager。开启 scripts 不增加 manager/store。

JSON cursor 固定 rootId、streamId、bootId、epoch，保留 retention/gap，Host replacement 不延续旧 cursor。wait 要求 caller signal，完成/取消即撤销订阅，不拥有生产者。执行生命周期见 [Dev Console](DEV_CONSOLE.md)。
