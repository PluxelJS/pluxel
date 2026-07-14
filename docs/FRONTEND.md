# Frontend Architecture

业务 HTTP 与 Workbench 是两条独立路径。Workbench 是 optional frontend capability，不得成为插件核心
能力的启动前提。

## Contract and ownership

`WorkbenchExtension` 是唯一插件级声明单元：

- `model` 声明 typed RPC、collection 和 events；
- `views` 声明 route、slot 或 builtin document，并为每个 view 选择 model keys；
- `ports` 声明 consumer outlet 或 provider renderer；
- `entry` 只声明浏览器 bundle entry，不执行注册；
- plugin Context/effects 拥有 mount、provider 和 cleanup。

placement 由宿主解析。普通 view 只能投给自己；required-dependent 的自动投影只允许进入
`plugin.capabilities`。任意 consumer Tab 等位置必须由 consumer 声明 port，provider 只提供 renderer。

## Server/browser boundary

- server authoring：`@pluxel/runtime/workbench`；
- browser authoring：`@pluxel/runtime/workbench/ui`；
- build contract：`@pluxel/core/federation`，只供 host/toolchain 使用。

global layout 可下发 route 导航描述，但不附带 model grant。用户打开 route 后，route screen 才请求 owner
的 target layout 并加载 bundle。

UI entry 通过 type-only import 引用 extension，并调用 `createWorkbenchUi<typeof Extension>()`。服务端
declaration 不进入 browser module graph。每个 view 使用 `ui.view('ViewId').useModel()`，返回值只包含该
view 声明的 model；复用组件可以在 `view()` 中列出多个合法 view id，运行时仍按当前 layout item 授权。

layout 不公开 model owner/name，只下发 `grantId`。RPC、collection 和 events transport 在每次请求时由
registry 解引用并校验 kind。插件实例或 model graph 变化推进 grant revision 并撤销旧 grant；bundle-only
更新复用仍有效的 grant。collection events 按 grant 隔离，同一 browser transport 可为 active collection
grants 复用一条 multiplex connection；custom events 保持各自生命周期。

## Updates and isolation

extension mount/unmount、owner running state 和 bundle build 共用 catalog/layout revision；model grant 使用
独立 revision。Workbench 对每个 transport 只维护一条 layout revision connection，按需重取 global 或
target layout，并仅加载实际引用的 bundle。新 bundle 完成后原子替换 registrations；owner 移除时才卸载
旧 bundle 和 route cache。错误必须进入可见 error boundary 并记录，不能用空白或永久 loading 隐藏。

gate 随 plugin Context 隔离，registry 与 bundle store 由 host 共享。provider 永远保留 immutable owner
Context，不保存可切换的“当前 Context”。

## Implementation entries

- `packages/runtime/src/workbench/`
- `packages/runtime/src/services/workbench/`
- `packages/components/src/workbench/`
- `packages/rolldown/src/vite/workbench-ui.ts`
