# Remaining Design Surface Reduction

状态：提案，尚未实现。

本文审计近期 core、runtime、static/dynamic route、Workbench 和 toolchain 重构后仍然存在的设计支线。目标不是进一步抽象，而是删除已经没有唯一职责、没有真实消费者或与当前权威设计冲突的概念。

## 结论

建议按以下顺序处理：

| 顺序 | 决策                                                | 置信度 | 主要收益                                         |
| ---- | --------------------------------------------------- | ------ | ------------------------------------------------ |
| 1    | 删除 demo-only plugin worker 子系统                 | 高     | 删除一整套无 production 对等语义的能力           |
| 2    | 删除无消费者的 `runtimeDev.batches` mirror          | 高     | HMR API 不再复制进 runtime common capability bag |
| 3    | 把 builtin document 真正收窄为只读                  | 高     | 删除第二套表单、action 和 collection mutation UI |
| 4    | 收回 `@pluxel/runtime/shared` public-looking barrel | 中     | internal helper 不再伪装成稳定用户概念           |

前三项以删除为主，可以独立落地。第四项只有在不增加新的公开概念时才应推进。

## 1. 删除 demo-only plugin worker 子系统

### 问题

当前 worker 设计由以下链条组成：

```text
@pluxel/runtime/plugin worker()
  -> Context.runtimeDev.worker
  -> runtime-dynamic BundlerService
  -> bundle-worker.mjs + Tinypool
  -> PluginHttpWorkerDemo
```

它存在四个结构性问题：

1. 仓库内唯一真实消费者是 `PluginHttpWorkerDemo`；没有 user docs 或业务插件使用；
2. static/production route 不构建 worker，只返回 fallback，作者仍需自行维护另一份 production worker；
3. `@pluxel/runtime-dynamic/plugin` 只是给同一 API 增加 `LoaderHmrWorker*` 别名，没有消费者；
4. Bundler、worker process、module graph、author facade 和 demo 合计形成一套独立生命周期，却没有对应的 production build contract 或独立回归测试。

这违反“开发和生产保持同一插件写法”的工具链方向，也把 dev convenience 提升成了公开 runtime capability。

### 提案

- 删除 `@pluxel/runtime/plugin` 的 worker API；
- 删除无消费者的 `@pluxel/runtime-dynamic/plugin` alias entry；
- 删除 `RuntimeDevCapabilities.worker`、`BundlerService`、worker bundle runner 和 demo；
- dynamic HMR host 不再创建、挂载和释放 BundlerService；
- 现阶段不设计 replacement。确实需要 production worker 的插件直接使用其构建产物和普通 effects cleanup。

如果未来要恢复 worker authoring，必须先由 toolchain 定义 production artifact、static/dynamic 一致的 declaration lowering 和 HMR replacement contract；不能只恢复 dev watcher。

### 验收

- 搜索不到 `PluginWorkerDeclaration`、`LoaderHmrWorker`、`watchTinypoolWorker` 和 `BundlerService`；
- dynamic host 不再安装 `runtimeDev.worker`；Workbench compiler 继续直接绑定 root artifact service；
- static 与 dynamic 的公开作者 API 不再因 worker dev helper 分叉；
- 删除 demo 后，插件 host catalog、UI build 和 HMR tests 仍通过。

### 未决问题

唯一需要产品层确认的是：是否存在仓库外、必须由 Pluxel 负责构建的 production worker。若没有已知消费者，不应为了假设需求保留当前半套实现。

## 2. 删除无消费者的 runtimeDev batch mirror

### 问题

dynamic host 已经持有唯一的 `LoaderHmrService`，其 `api` 原生提供 `lastBatch()`、`waitForBatch()`、
`waitForStable()` 和 `waitForIdle()`，host 返回值也直接暴露同一个 `hmr` 实例。但启动时仍把这些方法再次包装到
`ctx.runtimeDev.batches`：

```text
LoaderHmrService.api
  -> ctx.runtimeDev.batches wrapper
  -> no consumer
```

全仓没有代码读取 `runtimeDev.batches`；HMR 测试直接使用 `LoaderHmrService`。Workbench compiler 已不再经过
`runtimeDev`，因此这个 mirror 既不是作者能力，也不是跨 route contract，只是把 dynamic 私有 API 复制到 runtime
common 的可选 capability bag。

### 提案

- 删除 `RuntimeDevCapabilities.batches` 和 dynamic host 的 wrapper assignment；
- host、CLI 或测试需要等待 batch 时直接使用已经返回的 `LoaderHmrService`；
- plugin worker 子系统删除后，一并删除空的 `RuntimeDevCapabilities`、`runtimeDevCapabilities()` 和 Context
  augmentation；
- 不把 `LoaderHmrService` 或其 batch types 上移到 runtime common，也不设计新的 HMR adapter。

### 验收

- 搜索不到 `runtimeDev.batches` 和 runtime common 中的 HMR batch method mirror；
- dynamic host 仍通过自己的 `hmr` handle 提供精确类型的 batch API；
- runtime common 不再声明只由 dynamic route 写入的 dev capability bag；
- batch debounce、stable wait、host stop 和 HMR replacement tests 继续通过。

## 3. 把 builtin document 收窄为只读

### 问题

当前权威设计已经明确：builtin document 只用于 host-rendered read-only 内容，交互流程使用 React View + typed RPC。示例 `PluginBuiltinShowcase` 也只使用 info card 和 collection ref。

实现仍保留旧的交互分支：

- `BuiltinFormBlock`、`BuiltinActionBlock`、`BuiltinResourceSelectBlock`；
- template value 和 SignalDB write spec；
- `SignalDbForm.tsx`、`SignalDbAction.tsx`、`ResourceSelect.tsx`；
- collection `clientWrites`、push、POST route 和 server-side changeset apply；
- `SignalDbCollectionHandle.doc()/form()/action()/*Spec()` author helpers。

这些分支只有实现测试，没有业务消费者。更关键的是，`WorkbenchBackend.mount()` 对 projected 和 managed collection 都固定传入 `clientWrites: false`，所以公开 binding 创建的 collection mutation 请求必然返回 readonly。当前代码同时宣称 builtin document 只读，又维护一条公开路径无法启用的写入协议。

### 提案

保留：

- `workbenchContract.document()`；
- markdown/schema/info-card read model；
- read-only collection ref 和实时 snapshot；
- `bind.collection()` 与 `bind.managedCollection()`；
- React View 中的 read-only collection hook；
- mutation 使用 typed RPC。

删除：

- builtin form/action/resourceSelect block 及其组件；
- collection write/template types 和 `doc()` write helpers；
- `clientWrites` negotiation、UI push queue、collection POST route 和 changeset apply；
- 只为上述路径存在的测试与 exports。

`managedCollection()` 不能随之删除。它被多个真实插件用于 Workbench-owned state，问题只在于把该状态暴露成浏览器直接可写。

### 验收

- `BuiltinDocBlock` 只包含 read-only block；
- collection transport 只有 load + event invalidation/snapshot，不存在 client push；
- builtin document 的 bundle 不包含 form/action/resourceSelect renderer；
- React View mutation 示例全部通过 typed RPC；
- projected 与 managed collection 的 owner cleanup、grant revoke 和 HMR replacement 测试继续通过。

### 未决问题

若仓库外确有 builtin interactive document 消费者，需要在实施前二选一：要么把其迁移到 React + RPC，要么修改当前 Workbench 权威设计并正式承担第二套 UI schema。不能继续保持文档只读、实现半可写的状态。

## 4. 收回 runtime shared barrel

### 问题

`@pluxel/runtime/shared` 暴露 cache、filesystem、OXC resolver、node_modules、Vite ID、missing-dependency recovery 和 export conditions。它没有用户文档或业务插件消费者；production consumers 都是 runtime、runtime-dev 和 runtime-dynamic 内部实现。

名字 `shared` 同时隐藏所有权并让内部 helper 看起来像稳定用户 API，与 Governance 的 explicit/internal export 规则不一致。

### 提案

- 删除 `./shared` public export；
- runtime 包内改用相对 import；
- 跨包调用统一从现有 `@pluxel/runtime/internal` 取得，或在确有 bundle isolation 需求时使用一个明确的 internal subpath；
- 不把这些 Node/Vite helper 移入 core，也不让 runtime 反向依赖 Rolldown。

这项工作的成功标准是少一个 public-looking 概念，不是把一个 barrel 拆成十个新 subpath。如果 bundle inspection 证明现有 `internal` entry 会把不需要的 Node implementation 拉入某个产物，应只为那条已测量的边界保留一个窄 internal entry。

### 验收

- package exports 不再包含 `./shared`；
- user-facing package surface 不出现 cache/resolver/Vite ID helper；
- runtime common 仍不依赖 dynamic 或 Rolldown；
- static headless bundle closure 不因 internal re-export 增加 Workbench、Vite 或 dynamic loader。

## 不应推进的重构

以下方向当前没有足够收益：

- 不因为 `PluginService`、static host 或 collection service 文件较大就机械拆 class；先删除上面的失效分支，再评估剩余职责；
- 不合并 static catalog 与 dynamic loader。它们共享 core lifecycle facts，但 code discovery 和 HMR policy 本来就不同；
- 不创建统一 service manager。常驻服务由 runtime main side-effect 注册，可选 Workbench/Vault 继续显式安装已经足够；
- 不把 runtime-dev、Vite 或 filesystem helper 移入 core；
- 不把 Workbench collection、events 和 RPC 强行做成一个通用 transport abstraction；三者的 consistency 和 backpressure 语义不同；
- 不为删除的入口保留 alias。当前 major Changeset 已经承担 clean-slate surface cleanup。

## 实施顺序与停止条件

建议每项独立提交，并在删除后立即搜索旧符号。顺序上先删除 worker 和无消费者的 batch mirror，使
`runtimeDev` capability bag 整体消失；再完成 builtin read-only cut；最后才处理 internal barrel。

任一项遇到以下情况应停止并重新评估，而不是增加 adapter：

- 找到仓库外必须支持的明确 consumer；
- 删除会迫使 core 依赖 host/toolchain；
- static/dynamic 必须复制 lifecycle 才能完成迁移；
- disabled Workbench 开始创建 backend/compiler/watcher；
- 为保持兼容需要新增与旧概念等量的 facade。

完成某项后，应把稳定结论写入对应领域文档，并从本 proposal 删除已实现部分。
