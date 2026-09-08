---
title: 常见错误与排查
description: 按构建、依赖图、配置、生命周期和宿主边界定位 Pluxel 集成问题。
---

先按报错或看得见的现象找对应小节。构建问题在失败的 package 目录重跑原命令；正在运行的应用先读取真实状态和日志，避免用重启掩盖原因。

Coding agent 检查当前 Vite 应用时，使用[开发控制台](../development/dev-console.md)：先发现实例，固定 `--root` 与 `--instance`，再读取状态、执行操作并核对领域结果。

## 刚发布的版本安装时报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`

这表示当前项目或机器配置了 `minimumReleaseAge`，所需版本仍在等待窗口内，不等于 npm 上没有该版本。先看错误中的发布时间与 cutoff；1440 分钟就是 24 小时。创建新应用应从普通项目目录执行，避免继承框架源码 workspace 的依赖政策。

最直接的处理是等该版本满足等待期后，重跑原安装命令。团队确认要立即使用这个版本时，可以按现有依赖政策批准针对具体包的 `minimumReleaseAgeExclude`，不要为一次安装关闭全部依赖的等待策略。

## 构建无法解析包或 subpath

例如 `Failed to resolve import "valibot-form/web"`：

1. 确认报错文件所在的 package 直接声明了 `valibot-form`，不要依赖根目录偶然 hoist 的依赖。
2. 查看所安装版本的 `package.json#exports`，确认包含 `./web`，并检查它指向的文件是否存在。
3. 若解析的是 workspace 包，确认部署构建先完成该依赖的 build。只运行页面项目的 Vite build 不一定构建 workspace 依赖；使用仓库定义的完整部署命令。
4. 本地正常而 CI 失败时，比较干净 checkout 中的安装与构建顺序；本地旧 `dist/` 可能掩盖缺失步骤。

不要把浏览器真正需要的模块加到 `external` 来消除报错；这样可能只是把构建失败变成浏览器加载失败。使用跨仓库源码时，先运行 `pluxel source doctor`，再按[源码开发](../development/source-workspaces.md)检查生成的解析配置。

## Plugin 看起来是普通 class

**现象：** Plugin 元数据、依赖、`configs.use()` 或 HMR 行为缺失。

Plugin 源码必须经过 Pluxel 的 Vite/Rolldown 转换。不要用普通 TypeScript runner 直接执行 Plugin 文件，也不要把包的构建命令替换成裸 `tsc`。构建使用 `pluxel build`，测试使用 [Pluxel 测试宿主](../development/testing.md)。

若出现 `plugin_lowering_abi_unsupported`，说明已构建 Plugin 与当前 Core/Runtime 工具链不属于同一 lowering ABI。升级匹配版本的
Core、Runtime 与 Rolldown 后重新构建 Plugin；不要手写 toolchain payload 或把旧产物当作缺省 metadata 继续加载。

## Plugin 没有启动

Workbench 中“期望运行”表示运行意图，不保证 `init()` 成功。启动失败与依赖阻塞会保留在插件状态中，
无关操作不会清除；恢复运行或移除节点后清除。到实时日志中查找 `Plugin lifecycle operation failed`，
可查看插件引用、失败阶段及错误堆栈。启动操作的错误通知保留到手动关闭，“复制通知”包含完整生命周期回执。

若堆栈来自 PGlite 并包含 `Aborted()`，先检查是否有多个宿主共用同一数据目录。停止重复进程后完整重启宿主；
仅重试插件会复用已经初始化失败的共享数据库。重启仍失败时，保留错误堆栈并检查目录权限和数据库状态，
不要直接把删除数据库作为默认恢复步骤。

依次检查：

1. Plugin 是否进入宿主的 root/plugin plan；
2. required dependency 是否都可解析；
3. 启动或更新操作是否完成，返回结果是否报告失败；
4. 配置是否通过 schema 校验；
5. `init()` 是否抛错，或在 signal 取消后仍继续工作。

required dependency 失败会阻止消费者启动。optional provider absent、当前未运行或 start-failed 时 callback 不执行，但不会阻止消费者启动。参见 [Plugin 模型](../getting-started/plugin-model.md)。

Part constructor 的 required dependency 会提升到 owning Plugin graph。它缺失或启动失败时，整个 owner blocked；Part 不会被跳过，
也没有单独的 blocked/running 状态。dependency override 同样设置在 owning Plugin requirement 上，而不是 `partPath`。

## PluginPart constructor dependency 无法解析

- Part 必须是 concrete direct `PluginPart` subclass，并由普通 `parts.use(PartClass)` field 静态拥有；
- constructor 参数必须是从 provider package root value-import 的具体 Plugin type；type-only import 只用于 optional ref；
- 同一个 Part constructor 不能重复同一 definition，但 root、不同 Part 或同一 Part class 的多个 occurrence 可以合法共享；
- 不要在 owner constructor 重复一份 Part requirement，也不要用 `this.host` 充当未声明的 provider locator。

多个 occurrence 依赖同一 provider 时，graph 与 package metadata 会自动去重；任一来源为 required 时 effective mode 为 required。
完整标准写法见[使用 PluginPart](../getting-started/plugin-parts.md#依赖写在实际-consumer)。

## 无法从所属插件或测试读取 PluginPart 的 `ctx`、`host` 或 `plugins`

这些字段用于 Part 内部声明能力，不是外部业务 API。`PluginPart.ctx/host/parts/plugins/configs` 与 `BasePlugin.parts/plugins/configs` 是 protected declaration
DSL，只能在对应 subclass 内使用。Part 不提供 root-owner accessor；不要用类型断言、Context service locator、公开 path/id 或 wrapper
把这些 composition internals 重新泄露出去。

业务调用为 Part 定义最小 public method/property，测试优先观察 registration、cleanup 与显式业务 projection。需要定位 lifecycle failure
时读取 `PluginLifecycleErrorInfo.partPath`。Part occurrence Context 不提供 attribution path 或 identity；具体 Context capability type 和
immediate host class 由作者代码直接声明。完整边界见[只暴露业务 API](../getting-started/plugin-parts.md#只暴露业务-api)。

## Optional provider 不存在但 Part 仍被构造

这是预期行为。`parts.use()` 声明静态 containment；每个 owner generation 都会构造 Part、注入并校验 config，再调用一次
`init()`。`plugins.use()` 控制的是 callback 内的业务 activation，不控制 Part class 的加载或实例是否存在。保持 Part field
initializer 无副作用，并把该 integration 的 registration、资源和 cleanup 全部放进 callback。若实现 package 本身可能未安装，
或需要独立启停与失败状态，应使用 optional Plugin。

## 配置值是 `undefined` 或配置校验失败

- `this.configs.use(schema)` 必须是具体 Plugin 或 direct PluginPart subclass 的顶层普通 field；
- `this.parts.use(PartClass)` 必须完整占据普通 field initializer；Part 可以声明 required dependency constructor，但不能使用 `@Plugin`；
- schema 必须是支持的 object 形状，并且每个具体 Plugin/PluginPart class 各自只声明一次；
- 不要在 constructor 中读取配置；
- 默认值放进 schema，宿主输入仍要经过同一个 schema normalization。

完整规则见 [配置模型](../getting-started/configuration.md)。浏览器表单不是信任边界，提交后服务端仍需校验。

## 停止后端口、timer 或连接仍存在

资源创建成功后立即登记到当前 owner effects，或在 `init()` 返回 cleanup。不要只依赖进程退出和测试框架回收。替换 generation、部分初始化失败和正常 stop 都必须走同一条清理路径。

## HTTP 返回 404

业务路由与 Workbench View API 使用不同边界：

- 业务 API 直接注册到 generation-scoped `ctx.elysia`；
- Elysia 中声明的 path 就是最终产品 path，不会再自动增加 Plugin namespace；
- Workbench API 只有启用 Workbench、owner publication 生效且用户实际打开 View 时才创建 fresh target；
- route 必须在 Plugin/Part 的 construction 或 `init()` authoring window 声明；finalization 后 app 已由 Elysia 2 seal；
- `/__pluxel` 是保留 namespace，跨 owner 的相同 method/path 冲突会使 contribution 启动失败；
- stop、replacement 或 rollback 后旧 generation 的 handler 不应继续服务。

先查看 commit/lifecycle summary，确认 Plugin 正在 running 且 finalization 没有因 reserved path、route conflict、lazy module 或 compile
失败。测试时直接请求最终地址，例如 `host.http.fetch(new URL('/orders/1', host.http.origin))`。

当前 Node production、static Vite 与 dynamic Vite carrier 已支持并验证基础业务 WebSocket；若 `.ws()` 返回 404，除 route
publication 外还要确认请求经过真实 Upgrade listener，而不是 `host.http.fetch()`。不要依赖仅参数名不同的 route pattern 自动获得完整冲突诊断；测试应覆盖你的实际 URL 和 Upgrade 请求。

参见 [插件 HTTP](../runtime/http.md) 与 [管理工作台](../workbench/index.md)。

## 导入路径存在于源码但 package 无法安装

检查 [Package 与入口矩阵](./package-matrix.md)。`private: true` package 仅供 workspace 使用；`internal` 和未列入 `exports` 的路径不是作者入口。

## 诊断信息

诊断记录应包含 Plugin definition/node address、generation、宿主形态、commit summary、结构化错误 code、owner 日志，以及取消或停止状态。debug 日志只针对已经确定的配置、graph、request 或 lifecycle 边界启用。
