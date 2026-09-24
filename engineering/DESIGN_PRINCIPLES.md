# Engineering Rules

本文档是修改 Pluxel 时必须遵守的工程不变量，面向维护者和 coding agent。规则只保留能降低兼容成本、运行错误或维护复杂度的约束；不规定命名、排版等个人风格。

## 1. 保持插件作者模型稳定

- 未经明确设计决策，不改变现有插件调用方式。
- required plugin dependency 只写在 constructor；不得要求在 decorator 中重复声明。
- optional integration 使用 non-exported module-level `definePluginRef<T>()` 和 init-time
  `plugins.use(Ref, callback)`；ref 只观察 host catalog，不加载、安装实现包，也不改变其自动启动策略。
- 具体 Plugin package 只有 package root `"."` 可以承载 Plugin；每个 constructor 只有一个 root named export。
- `@Plugin({ displayName })` 只提供展示默认值；definition/node identity 来自 canonical entry + root export。
- plugin 内部纯逻辑使用普通对象或函数；只需 cleanup 分组时使用 owner effects scope；需要自动派生 config、Context、effects 或 nested
  composition 时使用 `PluginPart`；需要独立治理时成为 Plugin。
- Plugin/Part composition declaration 只在 subclass 内使用 protected DSL；Part 对外只暴露自己声明的业务 API，不提供 root owner、
  Context attribution path 或 service locator escape hatch。
- 同一语义只保留一个公开入口，不新增兼容 alias 或平行 contract。
- raw Context construction、toolchain 和 runtime installation helper 不进入默认 Plugin 作者入口；
  `@pluxel/context` 的公开 installation helper 只用于 root 创建前的 host composition。

## 2. 保持能力所有权清晰

- Core 固定提供 logger、effects、events 和插件配置事实；Commands、Persistence、Vault 通过显式服务清单安装。`standardServices()` 组合 HTTP、Commands、NodeModules、Workers 和 Persistence；`servicesPreset()` 另加 Vault、Logging、Management、管理命令及可选 Workbench，不默认安装 Database。`ctx.events` 提供通过
  module augmentation 扩展的松耦合 host 广播；具名 `EvtChannel` 属性表达沿 Plugin dependency edge 暴露的显式协议。
  ambient event 类型声明不建立、加载或替代 Plugin graph dependency。
- standalone host 可以用 `@pluxel/context` 组合自己的封闭能力集合；Plugin Host 的 Context 由宿主在 root 创建前组合；第三方服务通过 `@pluxel/core/host` 使用 Core 所有的 descriptor 身份，Plugin 不能追加、替换或运行时安装 capability。
- Workbench definition 只能通过可选的 `ctx.workbench?.publish()` 发布；页面 API 直接使用 fresh Cap’n Web
  `RpcTarget`，跨 Plugin UI 只使用 provider-owned Attachment 与 consumer-owned placement。
- command 的 root catalog publication 与 carrier-specific publication 是两个显式决定。Carrier provider 通过
  caller-bound mount 固定 provider/consumer ownership，不接受 caller-supplied owner，也不自动镜像 root catalog。
- 宿主负责 Workbench Plane 安装、进程退出、部署和健康策略；插件不声明这些策略。
- 业务状态和业务 API 不得依赖可选 Workbench。

## 3. 可选能力关闭时不得产生隐式成本

- disabled capability 不安装 Context property，也不创建 backend、compiler、watcher、route、transport 或持久状态。
- optional callback 不执行时，插件仍能完成核心生命周期。
- 不使用 null stateful service 模拟成功注册。

Workbench 一旦启用，Cap’n Web over WebSocket、MF2 Manifest/Snapshot 和 React Bridge 都是固定实现契约；
disabled 只表示整个 Plane 不安装，不表示启用后可缺少其中任一项。

## 4. Context 必须并发隔离

- Context host 在创建时一次编译固定 shape；root、scope、child 和 owner view 都不能在创建后修改 plan。
- 已知成员集合和 owner 语义能由普通对象、class 或预编译 property descriptor 清晰表达时，Context projected getter、owner
  view、Plugin caller facade 与本地 capability handle 优先保持 Proxy-free。不要用 `Proxy` 隐式改写共享对象的 `ctx`、caller
  或 cleanup owner；这会破坏 cached handle 和异步并发的归属稳定性。
- Proxy 不是禁用项。若成员集合确实开放，或 Proxy 比 codegen、显式 `invoke(name)`、预编译 descriptor 更清晰且不牺牲反射、
  identity、调试与生命周期语义，可以在明确边界使用并记录取舍。浏览器 type-erased RPC stub 是当前实例；后端 owner-aware
  capability 路径没有这种需要。
- plugin-owned gate、logger、effects 和 registration 必须保留 owner Context。
- host 可以共享 registry，但共享对象不得通过可变“当前 ctx”识别调用者。
- 缓存 service handle、并发初始化和异步 callback 都不得造成 plugin node address 或 cleanup scope 串线。
- Core 把一个 kernel scope 映射为一次 Plugin generation，Part child 与 dependency caller view 共享 scope backing，
  但分别持有 owner-view cache；不引入新的全局上下文协议。

## 5. 生命周期只由 graph 和 commit 驱动

- provider 先启动、后停止；required failure 只传播到 dependents。
- `init()` 必须诚实报告无法提供能力的启动失败，不能记录日志后半启动。
- 资源创建成功后立即登记幂等 cleanup。
- `init()` 返回的 cleanup/disposable 自动进入当前 generation effects；replacement、rollback、optional
  restart、正常停止和 shutdown 只 drain 这一套 effects。
- core 返回 lifecycle facts；宿主决定退出、告警或降级。

## 6. 插件源码必须经过 Pluxel 工具链

- `@Plugin` 只保留 `displayName`、`startTimeoutMs`、literal `forkable: true` 和显式 abstract provider relation；
  `displayName` 不参与身份，forkability 只属于 concrete definition fact。
- Rolldown/Vite 共用 semantic pass，在 TypeScript 擦除前生成 root export、definition address、constructor
  required edge、optional ref/edge、forkability 与单 object config facts。
- generated declaration 只调用带 numeric ABI version 的 `@pluxel/core/toolchain`；
  module namespace 求值完成后，route 恰好一次消费并冻结 candidate，不从默认作者入口读取 setter。
- raw TypeScript runner 不作为插件源码入口；缺少 lowering facts 时必须 fail-fast，不能回退 reflection、class
  name 或 constructor identity。
- Node 原生 type stripping 只用于不依赖 decorator transform 的普通工具脚本。
- 工具链不得注入第二套作者 API。

## 7. 保持依赖方向

```text
Core: Context、Plugin graph 与 lifecycle
  ↑
Host: catalog、运行意图、来源与 dynamic 文件加载
  ↑
Services: HTTP、存储、日志、Management 与官方组合
Workbench: UI capability、客户端与随包 Shell
Host-dev / Rolldown: 开发驱动与构建工具
```

Services 与 Workbench 的可选组合可以形成包级相互引用；约束针对真实模块与求值入口，不要求每个领域都成为独立发布包。
基础服务与 browser-safe 协议不导入上层组合，未选择的后端不因同包而自动加载。

- context 是同步、host-neutral 的 Context kernel，不依赖 Core、Host、IO 或生命周期服务。
- core 不依赖 HTTP、持久化、Vite 或宿主策略。
- core 源码直接复用 context；发布的 Core JS 与 declarations 完全内联该 kernel，不产生
  `@pluxel/context` production dependency。
- core 与 commands 彼此独立；services 组合两者，但不把 command 变成插件内部生命周期协议。
- Host 的生产入口不依赖开发工具链；`@pluxel/host/dynamic` 在同包内通过来源契约接入文件发现。
- Host 来源接入不复制 core lifecycle。
- build-time tooling 不进入 runtime service graph。

## 8. 变更必须有对应验证

- 作者面变更：检查 public exports、user docs 和所有 workspace plugins。
- DI/metadata 变更：使用真实 Vite Module Runner 验证，不以 raw runner 结果代替。
- Context/service 变更：覆盖多插件、缓存 handle、并发和 cleanup ownership。
- optional capability 变更：同时验证 enabled 与 disabled。
- lifecycle 变更：覆盖 provider failure、dependent blocking、replacement 和 teardown。
- 删除旧设计后搜索旧符号、旧入口和旧文档链接。

## 9. 文档只描述当前事实

- `docs/` 给出标准用法和必要设计原因，不暴露 internal helper。
- `engineering/` 记录架构不变量和实现入口，不重复用户教程。
- 未实现内容只进入 `engineering/proposals/`。
- 当前文档不保存迁移过程或旧 API 清单；历史由 Git 保存。
