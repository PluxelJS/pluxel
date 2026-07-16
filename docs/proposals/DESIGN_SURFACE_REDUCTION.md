# Remaining Design Surface Reduction

状态：提案，尚未实现。

本文只记录当前实现中仍待删除的设计支线。Node module artifact pipeline 已成为当前架构，见
[`TOOLCHAIN.md`](../TOOLCHAIN.md) 与 [`RUNTIME.md`](../RUNTIME.md)。

## 1. 删除无消费者的 runtimeDev batch mirror

### 问题

dynamic host 已经持有唯一的 `LoaderHmrService`，其 `api` 原生提供 `lastBatch()`、`waitForBatch()`、
`waitForStable()` 和 `waitForIdle()`，host 返回值也直接暴露同一个 `hmr` 实例。但启动时仍把这些方法再次包装到
`ctx.runtimeDev.batches`：

```text
LoaderHmrService.api
  -> ctx.runtimeDev.batches wrapper
  -> no consumer
```

全仓没有代码读取 `runtimeDev.batches`；HMR 测试直接使用 `LoaderHmrService`。artifact compiler 已不再经过
`runtimeDev`，因此这个 mirror 既不是作者能力，也不是跨 route contract，只是把 dynamic 私有 API 复制到 runtime
common 的可选 capability bag。

### 提案

- 删除 `RuntimeDevCapabilities.batches` 和 dynamic host 的 wrapper assignment；
- host、CLI 或测试需要等待 batch 时直接使用已经返回的 `LoaderHmrService`；
- 一并删除空的 `RuntimeDevCapabilities`、`runtimeDevCapabilities()` 和 Context augmentation；
- 不把 `LoaderHmrService` 或其 batch types 上移到 runtime common，也不设计新的 HMR adapter。

### 验收

- 搜索不到 `runtimeDev.batches` 和 runtime common 中的 HMR batch method mirror；
- dynamic host 仍通过自己的 `hmr` handle 提供精确类型的 batch API；
- runtime common 不再声明只由 dynamic route 写入的 dev capability bag；
- batch debounce、stable wait、host stop 和 HMR replacement tests 继续通过。

## 2. 把 builtin document 收窄为只读

### 问题

当前权威设计已经明确：builtin document 只用于 host-rendered read-only 内容，交互流程使用 React View + typed RPC。
实现仍保留旧的交互分支：

- `BuiltinFormBlock`、`BuiltinActionBlock`、`BuiltinResourceSelectBlock`；
- template value 和 SignalDB write spec；
- `SignalDbForm.tsx`、`SignalDbAction.tsx`、`ResourceSelect.tsx`；
- collection `clientWrites`、push、POST route 和 server-side changeset apply；
- `SignalDbCollectionHandle.doc()/form()/action()/*Spec()` author helpers。

这些分支只有实现测试，没有业务消费者。`WorkbenchBackend.mount()` 对 projected 和 managed collection 都固定传入
`clientWrites: false`，所以公开 binding 创建的 collection mutation 请求必然返回 readonly。

### 提案

保留：

- `workbenchContract.document()`；
- markdown/schema/info-card read model；
- read-only collection ref 和实时 snapshot；
- `bind.collection()` 与 `bind.managedCollection()`；
- React View 中的 read-only collection hook；
- mutation 使用 typed RPC。

删除 builtin form/action/resourceSelect block 及其组件、collection write/template types、`doc()` write helpers、
`clientWrites` negotiation、UI push queue、collection POST route、changeset apply，以及只为这些路径存在的测试与 exports。

`managedCollection()` 不能随之删除。它被多个真实插件用于 Workbench-owned state，问题只在于把该状态暴露成浏览器直接可写。

### 验收

- `BuiltinDocBlock` 只包含 read-only block；
- collection transport 只有 load + event invalidation/snapshot，不存在 client push；
- builtin document 的 bundle 不包含 form/action/resourceSelect renderer；
- React View mutation 示例全部通过 typed RPC；
- projected 与 managed collection 的 owner cleanup、grant revoke 和 HMR replacement 测试继续通过。

## 3. 收回 runtime shared barrel

### 问题

`@pluxel/runtime/shared` 暴露 cache、filesystem、OXC resolver、node_modules、Vite ID、missing-dependency recovery 和
export conditions。它没有用户文档或业务插件消费者；production consumers 都是 runtime、runtime-dev 和
runtime-dynamic 内部实现。

名字 `shared` 同时隐藏所有权并让内部 helper 看起来像稳定用户 API，与 Governance 的 explicit/internal export 规则不一致。

### 提案

- 删除 `./shared` public export；
- runtime 包内改用相对 import；
- 跨包调用统一从现有 `@pluxel/runtime/internal` 取得，或在确有 bundle isolation 需求时使用一个明确的 internal subpath；
- 不把这些 Node/Vite helper 移入 core，也不让 runtime 反向依赖 Rolldown。

成功标准是少一个 public-looking 概念，不是把一个 barrel 拆成十个新 subpath。如果 bundle inspection 证明现有
`internal` entry 会把不需要的 Node implementation 拉入某个产物，应只为那条已测量的边界保留一个窄 internal entry。

### 验收

- package exports 不再包含 `./shared`；
- user-facing package surface 不出现 cache/resolver/Vite ID helper；
- runtime common 仍不依赖 dynamic 或 Rolldown；
- static headless bundle closure 不因 internal re-export 增加 Workbench、Vite 或 dynamic loader。

## 不应推进的重构

- 不因为文件较大就机械拆 class；先删除失效分支，再评估剩余职责；
- 不合并 static catalog 与 dynamic loader；
- 不创建统一 service manager 或通用 artifact target/strategy registry；
- 不把 runtime-dev、Vite 或 filesystem helper 移入 core；
- 不把 Workbench collection、events 和 RPC 强行做成一个通用 transport abstraction；
- 不为删除的入口保留 alias。

完成某项后，应把稳定结论写入对应领域文档，并从本 proposal 删除已实现部分。
