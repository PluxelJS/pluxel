---
title: 常见错误与排查
description: 按构建、依赖图、配置、生命周期和宿主边界定位 Pluxel 集成问题。
---

遇到问题时，先判断它发生在构建转换、依赖图提交、配置注入还是资源回收阶段。下面按常见现象给出检查顺序。

## Plugin 看起来是普通 class

**现象：** Plugin 元数据、依赖、`configs.use()` 或 HMR 行为缺失。

Plugin 源码必须经过 Pluxel 的 Vite/Rolldown 转换。不要用普通 TypeScript runner 直接执行 Plugin 文件，也不要把包的构建命令替换成裸 `tsc`。构建使用 `pluxel build`，测试使用 [Pluxel 测试宿主](../development/testing.md)。

若出现 `plugin_lowering_abi_unsupported`，说明已构建 Plugin 与当前 Core/Runtime 工具链不属于同一 lowering ABI。升级匹配版本的
Core、Runtime 与 Rolldown 后重新构建 Plugin；不要手写 toolchain payload 或把旧产物当作缺省 metadata 继续加载。

## Plugin 没有启动

依次检查：

1. Plugin 是否进入宿主的 root/plugin plan；
2. required dependency 是否都可解析；
3. graph 是否已经 commit；
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

## 无法从 owner 或测试读取 PluginPart 的 `ctx`、`host` 或 `plugins`

这是有意的 author boundary。`PluginPart.ctx/host/parts/plugins/configs` 与 `BasePlugin.parts/plugins/configs` 是 protected declaration
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
publication 外还要确认请求经过真实 Upgrade listener，而不是 `host.http.fetch()`。external setup/cleanup attach、第二个非 Node carrier、
完整 socket parity 与 canonical-equivalent route collision 仍缺少稳定 public seam；不要依赖仅参数名不同的 route pattern 自动获得完整冲突诊断。

参见 [插件 HTTP](../runtime/http.md) 与 [管理工作台](../workbench/index.md)。

## 导入路径存在于源码但 package 无法安装

检查 [Package 与入口矩阵](./package-matrix.md)。`private: true` package 仅供 workspace 使用；`internal` 和未列入 `exports` 的路径不是作者入口。

## 诊断信息

诊断记录应包含 Plugin definition/node address、generation、宿主形态、commit summary、结构化错误 code、owner 日志，以及取消或停止状态。debug 日志只针对已经确定的配置、graph、request 或 lifecycle 边界启用。
