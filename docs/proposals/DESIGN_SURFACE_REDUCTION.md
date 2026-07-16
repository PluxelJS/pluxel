# Remaining Design Surface Reduction

状态：提案，尚未实现。

本文审计近期 core、runtime、static/dynamic route、Workbench 和 toolchain 重构后仍然存在的设计支线。目标不是进一步抽象，而是删除已经没有唯一职责、没有真实消费者或与当前权威设计冲突的概念。

## 结论

建议按以下顺序处理：

| 顺序 | 决策                                                | 置信度 | 主要收益                                             |
| ---- | --------------------------------------------------- | ------ | ---------------------------------------------------- |
| 1    | 删除旧 `@pluxel/runtime/frozen`                     | 高     | production freezer 只保留一条路径                    |
| 2    | 删除 demo-only plugin worker 子系统                 | 高     | 删除一整套无 production 对等语义的能力               |
| 3    | 把 builtin document 真正收窄为只读                  | 高     | 删除第二套表单、action 和 collection mutation UI     |
| 4    | 删除 core process-global runtime/env 标记           | 高     | core 恢复 host-free，Context 不读取可变进程身份      |
| 5    | 收回 `@pluxel/runtime/shared` public-looking barrel | 中     | internal helper 不再伪装成稳定用户概念               |
| 6    | 让 runtime-dev 统一安装 Workbench compiler binding  | 中     | static/dynamic 不再分别手写同一 attachment lifecycle |

前四项以删除为主，可以独立落地。第五、六项只有在不增加新的公开概念时才应推进。

## 1. 删除旧 runtime frozen host generator

### 问题

当前 production static application 的唯一权威路径已经是：

```text
defineStaticRuntime() entry
  -> @pluxel/rolldown/build staticApplication()
  -> target bootstrap + distribution
```

但 `@pluxel/runtime/frozen` 仍公开 `buildFrozenHost()`。它生成另一份 bootstrap source，直接创建 `Context`、安装 dynamic loader services 并调用 `ctx.loader.preloadPlugins()`。这不是 canonical static application freezer，也不复用 static catalog、startup resolver、deployment manifest 或 target adapter。

仓库内只有 `packages/runtime/tests/frozen/build-frozen-host.test.ts` 使用该入口；CLI production smoke 使用的是 Rolldown static application distribution。

因此这里不是两个 target，而是两个互不一致的 production model。

### 提案

- 删除 `@pluxel/runtime/frozen` export、tsdown entry 和 tsconfig path；
- 删除 `packages/runtime/src/frozen.ts`、`packages/runtime/src/runtime/contracts.ts` 和专属测试；
- production freezer 只保留 `@pluxel/rolldown/build` 的 `staticApplication()`；
- 将 `docs/RUNTIME.md` 中泛称的 “frozen launcher” 改成明确的 production static launcher，避免再推导出第三种 route。

不提供 compatibility wrapper。公开版本变更通过 Changeset 表达。

### 验收

- 搜索不到 `buildFrozenHost`、`FrozenPluginSpec`、`frozen-host.mjs` 和 `@pluxel/runtime/frozen`；
- static application 的 Vite 与 production build 仍加载同一个 `defineStaticRuntime()` entry；
- CLI application template smoke 同时覆盖 headless/workbench distribution；
- deployment 输出不残留 `@pluxel/*` runtime import。

## 2. 删除 demo-only plugin worker 子系统

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
- dynamic host 的 `runtimeDev` 只保留真正由 route 提供的 batch/Workbench 能力；
- static 与 dynamic 的公开作者 API 不再因 worker dev helper 分叉；
- 删除 demo 后，插件 host catalog、UI build 和 HMR tests 仍通过。

### 未决问题

唯一需要产品层确认的是：是否存在仓库外、必须由 Pluxel 负责构建的 production worker。若没有已知消费者，不应为了假设需求保留当前半套实现。

## 3. 把 builtin document 收窄为只读

### 问题

当前权威设计已经明确：builtin document 只用于 host-rendered read-only 内容，交互流程使用 React View + typed RPC。示例 `PluginBuiltinShowcase` 也只使用 info card 和 collection ref。

实现仍保留旧的交互分支：

- `BuiltinFormBlock`、`BuiltinActionBlock`、`BuiltinResourceSelectBlock`；
- template value 和 SignalDB write spec；
- `SignalDbForm.tsx`、`SignalDbAction.tsx`、`ResourceSelect.tsx`；
- collection `clientWrites`、push、POST route 和 server-side changeset apply；
- `SignalDbCollectionHandle.doc()/form()/action()/*Spec()` author helpers。

这些分支只有实现测试，没有业务消费者。更关键的是，`DefaultWorkbenchBackend.mount()` 对 projected 和 managed collection 都固定传入 `clientWrites: false`，所以公开 binding 创建的 collection mutation 请求必然返回 readonly。当前代码同时宣称 builtin document 只读，又维护一条公开路径无法启用的写入协议。

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

## 4. 删除 core process-global runtime/env 标记

### 问题

`packages/core/src/env.ts` 把 `std-env` 和一个 process-global `'core' | 'hmr'` 标记挂到所有 `Context.prototype.env`。static entry 设置 `'core'`，dynamic host 启动时设置 `'hmr'`。

仓库中没有代码读取 `getPluxelRuntime()`、`isCoreRuntime()`、`isHmrRuntime()` 或 `ctx.env.runtime`；只有 launcher 写入。该状态也不会在 dynamic host stop 时恢复，因此同进程测试、多 host 或先 dynamic 后 static 的场景会观察到与具体 Context 无关的最后写入值。

route 类型是 host policy，不是 core plugin capability。core 因此额外依赖 `std-env`、持有 global symbol 并修改 Context prototype，却没有提供真实语义。

### 提案

- 删除 `PluxelRuntime`、getter/setter、global symbols 和 launcher 写入；
- 删除 `@pluxel/core/env` export 与 core 对 `std-env` 的依赖；
- 删除 `Context.prototype.env` 注入；
- 不新增 Context-local runtime kind 作为替代。

插件需要业务环境值时使用 config；static application 需要部署信息时使用 startup bindings；route 内部需要区分策略时依赖自己的显式对象，而不是作者 Context。

### 验收

- core 不读取进程环境、不修改 Context prototype、不持有 runtime-kind global；
- static/dynamic host 可以在同一测试进程顺序启动而没有共享 route identity；
- user docs 和 templates 不使用 `ctx.env`；
- core main export 和 package dependencies 同步收窄。

## 5. 收回 runtime shared barrel

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

## 6. 统一 Workbench dev compiler attachment

### 问题

static Vite route 与 dynamic HMR host 都手动完成以下步骤：

1. merge `WorkbenchCompilerServiceConfig`；
2. 从 backend 取得 artifact store；
3. 创建 `WorkbenchCompilerService`；
4. 写入 `ctx.runtimeDev.workbenchUiSource.bind`；
5. 在 effects 中 dispose compiler 并恢复旧 capability。

这不是 route policy，而是 runtime-dev compiler 自身的安装 lifecycle。两处手写会让 duplicate attachment、config merge、cleanup 和 disabled behavior 漂移。

### 提案

在 private `@pluxel/runtime-dev` 中保留一个 internal attachment function，由 static/dynamic 调用。它只负责 Workbench compiler binding，不接管：

- Context 创建；
- logging；
- HTTP 配置；
- dynamic batch/module capability；
- static catalog 或 host restart。

不要创建通用 `RuntimeHostManager`、`ServiceManager` 或 capability plugin framework。

### 验收

- `new WorkbenchCompilerService()` 只出现在 runtime-dev 内；
- static/dynamic 分别只做 enabled 判定和提供 Vite server/config；
- duplicate attach 被拒绝；
- dispose 后恢复 attachment 前的 `runtimeDev` state；
- Workbench disabled 时不加载 compiler implementation、不创建 watcher。

## 不应推进的重构

以下方向当前没有足够收益：

- 不因为 `PluginService`、static host 或 collection service 文件较大就机械拆 class；先删除上面的失效分支，再评估剩余职责；
- 不合并 static catalog 与 dynamic loader。它们共享 core lifecycle facts，但 code discovery 和 HMR policy 本来就不同；
- 不创建统一 service manager。常驻服务由 runtime main side-effect 注册，可选 Workbench/Vault 继续显式安装已经足够；
- 不把 runtime-dev、Vite 或 filesystem helper 移入 core；
- 不把 Workbench collection、events 和 RPC 强行做成一个通用 transport abstraction；三者的 consistency 和 backpressure 语义不同；
- 不为删除的入口保留 alias。当前 major Changeset 已经承担 clean-slate surface cleanup。

## 实施顺序与停止条件

建议每项独立提交，并在删除后立即搜索旧符号。顺序上先删除 frozen 和 worker，使 route/host wiring 变小；再完成 builtin read-only cut；然后删除 core env。最后才处理 internal barrel 和 compiler attachment。

任一项遇到以下情况应停止并重新评估，而不是增加 adapter：

- 找到仓库外必须支持的明确 consumer；
- 删除会迫使 core 依赖 host/toolchain；
- static/dynamic 必须复制 lifecycle 才能完成迁移；
- disabled Workbench 开始创建 backend/compiler/watcher；
- 为保持兼容需要新增与旧概念等量的 facade。

完成某项后，应把稳定结论写入对应领域文档，并从本 proposal 删除已实现部分。
