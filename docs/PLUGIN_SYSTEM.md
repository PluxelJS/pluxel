# Plugin System Architecture

本文定义当前插件系统边界。作者用法以 [`user-docs/plugin-authoring.md`](../user-docs/plugin-authoring.md)
为准。

```text
plugin source
  ├─ constructor dependencies
  ├─ config / feature declarations
  └─ Workbench Contract / Extension declarations
          ↓
@pluxel/core: committed graph / DI / lifecycle / effects
          ↓
@pluxel/runtime: HTTP / persistence / config / optional capabilities
          ↓
static or dynamic route: catalog / Vite / HMR / host policy
          ↓
optional Workbench Plane: target layout / artifacts / bound resources
```

## 依赖与组成

| 意图                    | API                                       | 生命周期含义                 |
| ----------------------- | ----------------------------------------- | ---------------------------- |
| required plugin         | constructor parameter                     | provider 失败会阻塞 consumer |
| graph-optional plugin   | `this.plugins.use(Token)`                 | 只监听已由 host 管理的 node  |
| package-optional plugin | `optionalPlugin()` + `plugins.use(Ref)`   | commit 后解析，包可不存在    |
| required local feature  | `this.features.use()`                     | 随宿主插件启动               |
| lazy local feature      | `defineLazyFeature()` + `features.load()` | 按需加载                     |

constructor 是 required dependency 的唯一作者声明。static/dynamic route 必须读取同一 committed core
graph；Workbench resolver 不依赖 loader 私有图。

`OptionalPluginRef` 是 opaque author declaration。core 的 `PluginHost` 只组合 availability subscription 与
`watchInstance()`；`@pluxel/runtime` 的 root-scoped `OptionalPluginAvailabilityService` 只去重 loader、维护 active
subscription，并把 candidate 提交给正常 graph transaction。synthetic module owner 直接使用 canonical plugin ID，
不再维护第二套来源身份。static/dynamic route 只改变 module resolver。首次发现的
candidate 写入 `optionalKnown` 并默认启用，之后显式 disabled state 优先。

optional load 在当前 commit settled 后执行，不能形成 nested transaction。absent 不阻塞 consumer；import/evaluation、
constructor、ID collision 和 start failure 进入结构化日志。只有 core running watcher 发布实例，replacement、retry 和
shutdown 继续复用正常 graph/effects。

## 生命周期与资源

core commit 顺序为 `draft graph -> verify -> stop plan -> start plan -> CommitSummary`。provider 先启动、
consumer 先停止；失败插件不进入 running，required dependents 被阻塞。effects 在 stop、replacement、
rollback 时清理。

Workbench mount 从 Context 推导 owner 并绑定 owner effects。contribution 只有在 owner 真正 running 后才进入
layout；init 失败不会留下可见 View 或 resource。HMR replacement 会撤销旧 layout binding、factory、stream、
collection 和 grant；rollback 通过重新 mount 获得新 lease。

## Optional Workbench Plane

插件只看到 `ctx.workbench.enabled` 和 `ctx.workbench.mount()`。宿主通过顶层 `workbench` 配置安装
backend。disabled 时不创建 registry、compiler、watcher、route 或 transport，mount 返回 `undefined`。

browser-safe `WorkbenchContract` 声明 resource、View、placement 和 Port；server-only `WorkbenchExtension`
只绑定 Contract 与 UI entry。`workbench.mount(extension, bindings)` 是唯一发布动作，owner 不在 Extension 重复
声明。registry
生成 target-specific layout，并把每个 resource 转成 resource-graph-revision-scoped opaque grant。
artifact 状态更新可以复用相同 grant；module、实例或依赖图变化会立即撤销旧 grant。浏览器不能按插件
namespace 任意访问未授予资源。

dependent 复用有两条明确路径：

- provider 的只读 capability view 可自动投影到 required dependents 的 host-owned capability 区；
- consumer 用 typed port 选择 placement 和自己的 binding，provider 用 renderer 实现统一 UI。

不维护服务端 UI session/draft。交互状态属于 consumer resource、浏览器局部状态或明确的业务 API。

## 包边界

- `@pluxel/core`：Context、graph、DI、lifecycle、effects；
- `@pluxel/runtime`：原样转发 core 作者面，并增加常驻 runtime 能力；
- `@pluxel/runtime/workbench/contract`：browser-safe Workbench Contract；
- `@pluxel/runtime/workbench`：服务端 Extension、entry 和 Binding；
- `@pluxel/runtime/workbench/ui`：浏览器 resource client；
- `@pluxel/core/federation`：Workbench bundle build contract；
- `@pluxel/runtime-static` / `runtime-dynamic`：route policy；
- `@pluxel/runtime-dev`：Workbench compiler；
- `@pluxel/rolldown/vite/workbench-ui`：remote build primitive。

## 不变量

- 业务 capability 不依赖 Workbench Plane；
- disabled 表示零 backend 初始化；
- host 拥有 placement，provider 不能任意占据 consumer UI；
- static/dynamic 的作者 API 和 graph 语义一致；
- active docs 只描述当前 API，历史由 Git 保存。
