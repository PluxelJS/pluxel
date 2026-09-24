# Plugin 第三方库版本边界提案

状态：待评审，未实现。日期：2026-09-24。

本文是版本与导入契约提案，不改变当前作者 API。当前行为以[Plugin 系统](../PLUGIN_SYSTEM.md)、
[HTTP](../../docs/runtime/http.md)、[Workbench](../WORKBENCH.md) 和
[API 契约](../../docs/api/contracts.md)为准。

## 1. 问题与判断原则

插件可以拥有任意内部依赖。版本需要由 Pluxel 约束的时刻，是插件把某个库的**运行时对象**交给宿主能力，
或者两个插件有意把该库类型与行为作为共同公开契约时。仅使用相同 npm 包、只引用类型、共用端口，
都不足以构成全局版本约束。

这两种跨边界需求不同：

| 边界                                                      | 需要一致的是什么                                | 版本政策的所有者          |
| --------------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| `ctx.require(Http)` 返回宿主 Elysia application           | 实例、扩展和宿主 carrier 所理解的 Elysia 运行时 | HTTP 服务                 |
| 插件向 Workbench 提供 `RpcTarget`，或借用宿主 RPC session | Cap’n Web capability、会话与传输实现            | Workbench                 |
| 插件自建 HTTP/RPC 端点及其客户端                          | 该端点自己的协议                                | 插件作者                  |
| 插件间有意交换 `better-result` Result 实例                | 公开的 Result API 与组合语义                    | 拟议的 Pluxel Result 入口 |
| RPC/Worker/JSON 中传递结果数据                            | 明确的 wire schema、领域错误与恢复语义          | 该数据协议的生产者        |

共享版本不是共享所有权。一个插件自行创建的 Cap’n Web 会话不因为运行在 Pluxel Host 中，
就必须使用 Workbench 的版本。反过来，插件为 Workbench 提供 target 时也不能用“我自己安装了同名包”
代替对宿主边界的兼容证明。

## 2. 当前事实与证据

- [HTTP 作者契约](../../docs/runtime/http.md#直接使用-elysia-能力)规定 `ctx.require(Http)` 是真实 Elysia 实例；
  消费它的插件声明精确 Elysia peer 和同版 dev dependency，不把私有副本打入 Plugin bundle。
  [静态构建](../../packages/rolldown/src/cli/elysia-singleton.ts)把公开入口解析到宿主的实现。
  [现有后续提案](NATIVE_ELYSIA_APPLICATION.md#包版本准入)已记录：模块 identity 成立仍不能代替发布包 peer range 准入；
  本提案不重复设计该准入机制。
- [Workbench 作者指南](../../docs/workbench/view.md)直接从 `capnweb` 导入 `RpcTarget`；
  [Workbench 定义](../../packages/workbench/src/workbench/definition.ts)也公开使用该类型。
  仓库 [catalog](../../pnpm-workspace.yaml)选择 `capnweb`，部分官方插件（如
  [Auth](../../plugins/auth/package.json)）声明它为 peer，
  [Workbench 构建](../../packages/workbench/tsdown.config.ts)将它排除出自己的 bundle。
  当前文档尚未像 HTTP 一样完整定义宿主 Workbench 与插件私有 RPC 的版本边界、版本准入和产物验证。
- [Workbench federation 约束](../WORKBENCH.md#mf2-与-react-bridge)的固定浏览器 singleton 清单不包含
  `capnweb`；因此不能把 React 的 singleton 保证直接套用到它。
- Core 当前同时发布 [ESM/CJS](../../packages/core/package.json)，而
  [`better-result` 上游 3.x](https://github.com/dmmulroy/better-result) 是 ESM-only；
  Core 已有[仅内部使用的轻量 Result](../../packages/core/src/internal/di/result.ts)，
  多个领域另有自己的判别结果。上游 2.x 到 3.x 有破坏性变化。

## 3. 拟议契约

### 3.1 Elysia 与 capnweb：宿主互操作依赖

沿用 Elysia 已有的模式，并把同一原则明确应用到 **Workbench 所消费的** `capnweb`：

1. 作者直接从上游库导入对象与类型；Pluxel 不为 `Elysia`、`RpcTarget`、`RpcStub` 建第二套命名或再导出入口。
2. 只有使用宿主对应能力的插件，才声明宿主支持的精确 peer 版本与同版 dev dependency。
   官方包通过 catalog 维护该版本。安装时的 peer 声明是兼容意图，不单独证明运行时只有一份模块。
3. 生产构建应让宿主与插件在同一互操作边界解析到兼容实现，不把另一份实例混入共享对象路径。
   静态与动态加载的验证方式可不同，结论必须覆盖两者。若实际协议只要求版本兼容而不要求对象 identity，
   用边界测试证明后可收窄 singleton 要求，不能仅由包名推断。
4. 插件自己拥有的 Elysia/Cap’n Web application、路由或 RPC 端点可以选择自己的版本。
   向宿主 Elysia app 注册扩展、向 Workbench 发布 target 等行为仍受前述宿主边界约束；
   通过 Fetch `Request`/`Response` 等标准数据边界接入独立实现，不等同于共享其内部对象。
5. 版本不匹配的诊断应指明拥有者、实际版本和宿主支持版本，并在发布不兼容能力前发生。
   不能把所有使用 `capnweb` 的包机械判为 Workbench contributor；准入信号必须来自实际 publication/能力依赖。

此项不会替代 Cap’n Web 自己的客户端/服务端协议兼容性。宿主 Workbench 会话和插件私有会话各自有协议所有者；
后者的版本与升级由插件决定。

### 3.2 better-result：可选的 Pluxel 公共 Result 入口

建议由 `@pluxel/core/result` 提供一个有界的 `better-result` 再导出，作为**希望在插件间公开 Result 实例**
的作者入口。使用者从该入口导入，并通过已要求的 `@pluxel/core` peer 共享 Pluxel 所选的 Result API；
Pluxel 负责其上游版本与公开 API 的升级。公开集合只覆盖实际被作者使用的 `Result`、错误构造与必要类型，
不自动转发整个上游包，也不复制实现或发明平行的 `Ok`/`Err` 契约。
发布的插件若使用该子入口，其 Core peer 范围必须以首次包含此入口的 Core 版本为下限；
仅写宽泛的 `^1` 不保证旧宿主存在这个入口。作者不再额外声明 `better-result` peer。

这个入口是可选工具，不修改 `Plugin.init()`、Command 的 `CommandError`、现有公开判别结果或业务方法签名。
插件内部仍可使用自己的库；只要对外承诺 Pluxel Result，返回值和调用方应走同一个公共入口。
纯业务 DTO、部分成功回执与“已保存但未应用”等状态按领域保留，不能机械压成 `Ok`/`Err`。
意外异常和生命周期启动失败仍按原契约传播。Result 实例不得直接作为 Workbench portable DTO；
跨传输时由边界投影并验证普通数据，消费端按领域协议恢复。

`@pluxel/core/result` 是拟议入口，不是已确认可发布的导出。Core 主入口继续保持不因 Result 加载上游包。
上游 ESM-only 与 Core 的双格式发布是否可在可选子入口中诚实支持，须由独立安装的 ESM/CJS 消费者验证；
若不能同时支持，应明确该子入口仅支持 ESM，且不得悄悄使 Core CJS 主入口失效。
再导出也不能单靠 import 路径保证进程中只有一份模块；构建与跨插件测试必须验证实际 identity 和行为。

### 3.3 版本策略适用于边界，不适用于整个插件系统

Plugin graph 的 required/optional dependency 表示业务能力和生命周期，不表示任意 npm 依赖的版本同步。
宿主只准入自己消费的能力合同；插件与插件之间的领域 API 由提供方声明兼容性。
普通工具、SDK、解析器、数据库客户端与插件私有协议由插件自行管理。

## 4. 采用步骤与验收

本提案不授权批量迁移现有业务 API。拟议的最小实施顺序：

1. 明确 Workbench `capnweb` 的宿主边界与官方支持版本，核对当前官方 peer 声明、构建外部化和真实连接。
   对一个仓库外独立安装的插件包验证兼容版本成功、不兼容版本有明确诊断，以及插件私有 RPC 不被误限制。
2. 实现可选 Result 子入口，并从独立安装的两个插件包分别导入、公开返回和消费一个 Result；
   验证类型声明解析、实际实例方法、构建产物、ESM/CJS 支持范围与 Core 主入口惰性。
3. 只在确有多步可预期失败且调用方会处理错误的一个官方流程中试用该入口。
   检查是否减少分支与转换成本；不以迁移文件数或统一表面格式作为成功指标。
4. 决策通过后更新[插件包指南](../../docs/development/plugin-package.md)、HTTP/Workbench 作者文档和
   [API 契约](../../docs/api/contracts.md)，再按公共包变更规则添加 changelog。用户文档只描述已实现行为。

验收条件是：宿主互操作与插件私有实现的版本政策可独立解释；兼容与不兼容的实际构建/运行路径有证据；
Result 的公开入口能被外部插件正确安装和消费；现有 RPC DTO、Command、生命周期与部分成功语义不退化。

## 5. 未决问题

- Workbench 的哪些具体加载路径必须共享 `capnweb` 模块 identity，哪些只要求客户端/服务端 wire 兼容？
  需从真实 publication、session 与构建产物验证，不能从 Elysia 的结论类推。
- `@pluxel/core/result` 的最小导出集合，以及双格式发布的可支持范围是什么？由独立安装探针决定。
- `capnweb` 的精确 peer 准入应复用哪一层现有 package metadata，而不让 Core 扫描文件系统或限制私有 RPC？
