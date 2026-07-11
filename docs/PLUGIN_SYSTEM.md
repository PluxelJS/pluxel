# Plugin System Architecture

本文档面向维护者，定义当前插件系统的内部边界。插件作者用法以 [`user-docs/plugin-authoring.md`](../user-docs/plugin-authoring.md) 为准。

## 一张图

```text
plugin source
  ├─ constructor dependencies ───────┐
  ├─ config / feature declarations ──┤ Vite/Rolldown metadata
  └─ ui() declaration ───────────────┘
                       ↓
@pluxel/core: graph / DI / lifecycle / effects
                       ↓
@pluxel/runtime: HTTP / persistence / config / runtime services
                       ↓
static or dynamic route: catalog / Vite / HMR / host policy
                       ↓
optional Web Management: UI / RPC / SSE / management state
```

插件是依赖和生命周期单元，不是部署策略单元。static/dynamic、是否启用管理面、失败是否退出进程都由宿主决定。

## 依赖与组成

四种关系必须保持正交：

| 意图                   | API                                       | 生命周期含义                        |
| ---------------------- | ----------------------------------------- | ----------------------------------- |
| required 插件依赖      | constructor parameter                     | provider 失败会阻塞 consumer        |
| optional 插件协作      | `this.plugins.use()`                      | provider 不运行时不执行，替换后重绑 |
| required 本地组成      | `this.features.use()`                     | 随宿主插件共同启动                  |
| lazy/optional 本地组成 | `defineLazyFeature()` + `features.load()` | 按需加载，可返回空                  |

constructor 是 required dependency 的唯一作者声明。`@Plugin` 从 `design:paramtypes` 读取 runtime token，不再要求重复 metadata。插件源码必须经过 Pluxel Vite/Rolldown 链；原始 TypeScript runner 不是插件入口。

## 生命周期

core 使用 commit 模型：

```text
draft graph -> verify -> stop plan -> start plan -> CommitSummary
```

- start：provider 在 consumer 之前。
- stop：consumer 在 provider 之前。
- `init()` 失败记录为 lifecycle issue，并阻塞 required dependents。
- 无关插件继续执行。
- effects scope 随插件 replacement、stop 和 rollback 清理。
- core 只返回事实；进程退出和健康策略属于宿主。

## Runtime 能力边界

常驻能力：

- config、logger、events、effects；
- HTTP plugin routes；
- persistence、plugin data、runtime state；
- registry/lifecycle read models。

可选宿主能力：

- Web Management：插件 UI、管理 RPC/SSE、management state、管理路由和资产；
- Vault：加密数据和宿主管理能力。

HTTP 不属于 Web Management。关闭管理面不影响插件业务路由。

## Web Management 内部模型

插件只看到 `ctx.webManagement.enabled` 和 `ctx.webManagement.use(callback)`。安装和 required access 是 runtime internal 函数。

隔离策略保持轻量：

- gate 随 plugin Context 隔离，缓存后仍绑定 owner Context；
- UI/RPC/SSE/state registry 按 host 共享；
- backend 为每个 Context 缓存绑定视图；
- registration cleanup 进入对应插件 effects scope；
- shared registry 不保存可切换的“当前插件 ctx”。

关闭 Web Management 时不安装 backend，也不创建 UI compiler、watcher、管理路由或 state transport；`use()` callback 不执行。

## UI pipeline

`ui()` 只产生 declaration，注册动作始终是 `web.ui.register(declaration)`。

开发：Vite route 接收源码 declaration，编译 remote 并发布诊断。

生产：插件构建生成 federation artifact，runtime 注册 artifact；runtime 不解析源码路径。

工具链可以降低 declaration，但不能替换作者调用或注入另一套运行时 API。

## 包边界

- `@pluxel/core`：Context、插件图、DI、生命周期、feature/config 声明。
- `@pluxel/runtime`：稳定作者面和常驻 runtime services。
- `@pluxel/runtime/web-management`：服务端管理面 declaration 和类型。
- `@pluxel/runtime/web`：浏览器插件 UI API。
- `@pluxel/runtime-static`：fixed catalog route。
- `@pluxel/runtime-dynamic`：loader、scan、module replacement 和 HMR route。
- `@pluxel/runtime/toolchain`：仅供生成代码使用的 metadata helper。

## 关键实现

- `packages/core/src/plugins/runtime/PluginService.ts`
- `packages/core/src/plugins/runtime/PluginDefinitions.ts`
- `packages/core/src/plugins/decorators/`
- `packages/runtime/src/services/web-management.ts`
- `packages/runtime/src/services/web-management/WebManagementService.ts`
- `packages/runtime/src/services/plugin-interaction/`
- `packages/runtime-static/src/internal/host.ts`
- `packages/runtime-dynamic/src/hmr/`
- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`

## 不变量

- 作者入口不导出 metadata mutation 或 host installation API。
- optional capability disabled 时没有隐式初始化。
- static/dynamic 不改变插件作者写法。
- toolchain metadata 与 runtime graph 必须可通过 Vite Module Runner 集成测试验证。
- active docs 不记录已删除 API 清单；历史由 Git 保留。
