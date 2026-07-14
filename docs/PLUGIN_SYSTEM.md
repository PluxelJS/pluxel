# Plugin System Architecture

本文定义当前插件系统边界。作者用法以 [`user-docs/plugin-authoring.md`](../user-docs/plugin-authoring.md)
为准。

```text
plugin source
  ├─ constructor dependencies
  ├─ config / feature declarations
  └─ WorkbenchExtension declarations
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

| 意图                   | API                                       | 生命周期含义                 |
| ---------------------- | ----------------------------------------- | ---------------------------- |
| required plugin        | constructor parameter                     | provider 失败会阻塞 consumer |
| optional plugin        | `this.plugins.use()`                      | provider 可缺失，替换后重绑  |
| required local feature | `this.features.use()`                     | 随宿主插件启动               |
| lazy local feature     | `defineLazyFeature()` + `features.load()` | 按需加载                     |

constructor 是 required dependency 的唯一作者声明。static/dynamic route 必须读取同一 committed core
graph；Workbench resolver 不依赖 loader 私有图。

## 生命周期与资源

core commit 顺序为 `draft graph -> verify -> stop plan -> start plan -> CommitSummary`。provider 先启动、
consumer 先停止；失败插件不进入 running，required dependents 被阻塞。effects 在 stop、replacement、
rollback 时清理。

Workbench mount 绑定 owner effects。`requireRunning` contribution 只有在 owner 真正 running 后才进入
layout；init 失败不会留下可见 view 或资源。HMR replacement 会撤销旧 layout binding、resource factory、
stream、collection 和 artifact。

## Optional Workbench Plane

插件只看到 `ctx.workbench.enabled` 和 `ctx.workbench.mount()`。宿主通过顶层 `workbench` 配置安装
backend。disabled 时不创建 registry、compiler、watcher、route 或 transport，mount 返回 `undefined`。

`WorkbenchExtension` 是静态 contract，`workbench.mount(extension, bindings)` 是唯一发布动作。registry
生成 target-specific layout，并把每个 resource 转成 resource-graph-revision-scoped opaque grant。
artifact 状态更新可以复用相同 grant；module、实例或依赖图变化会立即撤销旧 grant。浏览器不能按插件
namespace 任意访问未授予资源。

dependent 复用有两条明确路径：

- provider 的只读 capability view 可自动投影到 required dependents 的 host-owned capability 区；
- consumer 用 typed port 选择 placement 和自己的 binding，provider 用 renderer 实现统一 UI。

不维护服务端 UI session/draft。交互状态属于 consumer resource、浏览器局部状态或明确的业务 API。

## 包边界

- `@pluxel/core`：Context、graph、DI、lifecycle、effects；
- `@pluxel/runtime`：插件作者和常驻 runtime；
- `@pluxel/runtime/workbench`：服务端 Workbench contract；
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
