# Remaining Design Surface Reduction

状态：提案，尚未实现。

本文审计近期 core、runtime、static/dynamic route、Workbench 和 toolchain 重构后仍然存在的设计支线。目标不是进一步抽象，而是删除已经没有唯一职责、没有真实消费者或与当前权威设计冲突的概念。

## 结论

建议按以下顺序处理：

| 顺序 | 决策                                                | 置信度 | 主要收益                                          |
| ---- | --------------------------------------------------- | ------ | ------------------------------------------------- |
| 1    | 把 Node worker 纳入统一 plugin artifact pipeline    | 高     | 删除 dynamic-only bundler，并补齐 production 闭环 |
| 2    | 删除无消费者的 `runtimeDev.batches` mirror          | 高     | HMR API 不再复制进 runtime common capability bag  |
| 3    | 把 builtin document 真正收窄为只读                  | 高     | 删除第二套表单、action 和 collection mutation UI  |
| 4    | 收回 `@pluxel/runtime/shared` public-looking barrel | 中     | internal helper 不再伪装成稳定用户概念            |

第一项保留 Node worker 产品能力，但删除其独立编译支线并复用现有 Vite/Rolldown artifact pipeline；第二、三项以
删除为主。第四项只有在不增加新的公开概念时才应推进。

## 1. 把 Node worker 纳入统一 plugin artifact pipeline

### 决策

保留 Node worker authoring，但不保留当前 dynamic-only `BundlerService` 模型。Worker 与 Workbench UI 都是
“server declaration 指向另一份源码图，开发期即时构建，生产期加载预构建 artifact”，应共享同一套 declaration
extraction、源码图、hash/cache、watch/rebuild 和 artifact publication 基础设施。

共享发生在编译生命周期，不发生在输出格式：

```text
plugin source declaration
  -> canonical Rolldown declaration extraction
  -> source graph + build key + cache + atomic publication
       |-> Workbench UI builder -> browser Module Federation remote
       `-> Node worker builder  -> single Node ESM artifact
```

不把 Node worker 建模成 Workbench 子能力，也不把两个 builder 抽象成任意 target 的通用任务框架。

### 问题

Workbench UI 已经有完整闭环：

```text
workbench.entry(import.meta.url, './ui/index.tsx')
  -> workbenchUiBuildPlugin static extraction
  -> buildWorkbenchUiRemote() production artifact
  -> runtime-dev source compiler + watcher
  -> packaged/static artifact resolver
```

当前 worker 只复用了 Vite/Rolldown 的最后一步 bundle engine，却在外围重新实现一条不完整的链：

```text
@pluxel/runtime/plugin worker('./worker.ts')
  -> Context.runtimeDev.worker
  -> runtime-dynamic BundlerService
  -> duplicated moduleGraph/hash/watcher/cache
  -> Tinypool -> bundle-worker.mjs -> vite.build()
  -> temporary .mjs URL
```

具体问题：

1. `worker('./worker.ts')` 没有 `import.meta.url`，相对路径依赖 loader registry 或 cwd 猜测；
2. `BundlerService` 与 runtime-dev compiler 各自维护几乎相同的 Vite module graph collector、chokidar watcher、
   source hash 和 rebuild 去重；
3. `bundle-worker.mjs` 通过额外 Tinypool 才调用 `vite.build()`，隔离、缓存和发布语义不复用 Rolldown 已有的
   artifact scheduler；
4. `BundleJob` 同时声称支持 browser/node、CSS injection 和任意 external，但真实产品消费者只有 Node/Tinypool
   demo，形成没有需求支撑的通用 bundler surface；
5. `pluxel build` 不提取 worker declaration，插件 package 不输出 worker artifact；
6. static application freezer 不收集 worker artifact，动态加载已发布插件时也没有 packaged resolver；
7. static/non-HMR route 退回 inline fallback，导致相同插件在开发与生产采用不同执行模型。

问题不是 worker 不值得存在，而是它没有像 Workbench UI 一样成为 canonical toolchain artifact。

### 作者模型

唯一声明形式改为：

```ts
import { worker } from '@pluxel/runtime/plugin'

const squareWorker = worker.entry(import.meta.url, './worker.ts')
```

`worker.entry()` 返回 declaration；插件在 `init()` 中通过 `bind(ctx, { onUpdate, onError })` 获得当前可执行
artifact URL。构建 transform 可以向内部第三参数注入 artifact key，作者不声明 plugin ID、输出目录或环境模式。
`bind()` 必须等到首个 source/packaged artifact 完成校验后才 resolve，并以 `{ url, revision }` 调用一次
`onUpdate`；后续 HMR 成功再推送新 revision。首次构建失败使 `bind()` 失败，已有成功版本后的 rebuild failure 只调用
`onError` 并继续保留上一 revision。Binding snapshot 不再暴露 `hmr/fallback` mode。

约束：

- entry path 必须是 string literal，第一参数必须是 `import.meta.url`；
- 一个插件允许多个 worker，artifact key 由 declaration module path + entry path 稳定生成；
- worker 是 Node ESM/Tinypool artifact，不同时承诺 Web Worker、edge worker 或通用 job queue；
- worker 输入输出遵循 structured-clone 边界，不捕获 Plugin、Context 或其他进程内 service；
- declaration 不提供 `external` 和 inline fallback。Node builtins 由 builder 处理；无法安全 bundle 的 native/
  non-bundleable dependency 先明确报构建错误，不用开放式 external 绕过 production closure；
- artifact 缺失时 `bind()` 失败，插件 `init()` 诚实失败，不静默切换为 inline execution。

### 统一构建管线

`@pluxel/rolldown` 的 canonical `createPluginBuildPipeline()` 安装一次 internal `pluginArtifactBuildPlugin`。该 plugin
在同一次源码 transform 中提取 Workbench UI 和 Node worker declaration，并分别调用两个具体 builder：

- `buildWorkbenchUiRemote()`：保留现有 browser Federation contract；
- `buildNodeWorkerArtifact()`：新增直接调用 `vite.build()`/Rolldown 的 Node ESM builder。

二者共享：

- literal declaration extraction 与内部 artifact key 注入；
- Vite source graph collection；
- stable declaration artifact key、source/build signature 与 content-addressed build cache；
- 同一 artifact target 的 build 去重、staging、校验和原子发布；
- bounded historical artifact retention，保证 inflight UI import/worker task 不因新版本发布立刻失效；
- plugin package 与 static application 使用同一 `createPluginBuildPipeline()`，不复制 lowering 规则。

二者不共享输出 validator、runtime manifest 或 target-specific Vite config。Module Federation 的 process-wide
exclusive section 只包围 UI builder；Node worker build 不进入该临界区。

独立插件 package 输出：

```text
dist/
  index.mjs
  workbench/<ui-artifact>/...
  workers/<worker-artifact>/entry.mjs
```

static application freezer 把可达 worker artifacts 复制到 distribution，并把 artifact facts 写入现有 deployment
manifest。stable artifact key 标识 declaration，源码 hash 标识具体 build revision；不要把两者混成一个身份。
worker artifact 必须是自包含 Node ESM（Node builtins 除外）；不要新增部署端 package install 模式。只有声明 UI
或 worker 的 package 才加载对应 Vite builder；没有 artifact declaration 时 canonical pipeline 不创建额外输出目录。
Node worker 属于业务 runtime artifact，不属于 Workbench variant；headless 与 workbench static distribution 都应收集
可达 worker。现有 `workbench: false` 只关闭 UI extractor/builder，不能顺带关闭 worker branch。

### 统一开发期 compiler

`@pluxel/runtime-dev` 由每个 runtime root/Vite server 持有一个 source-artifact compiler。它保留两个具体绑定入口：

```text
bindWorkbenchUi(owner, declaration)
bindNodeWorker(owner, declaration)
```

内部共享 module graph refresh、watch set、hash、pending/inflight queue、cache retention 和 effects cleanup。目标构建
仍分别调用 `buildWorkbenchUiRemote()` 与 `buildNodeWorkerArtifact()`，不保留 `BundleJob` 或 strategy registry。

compiler 必须按 declaration 懒启动：

- 没有 worker declaration 时不创建 worker watcher、cache 或 build；
- Workbench disabled 时不安装 UI binder、不加载 Federation builder；
- Workbench disabled 但插件声明 worker 时，只构建 Node artifact；
- static Vite 与 dynamic HMR 都安装相同 worker source binder，route 只提供自己的 Vite server；
- owner replacement/stop 通过 owner effects 释放 watcher；旧成功 artifact 保留到 bounded cache cleanup；
- rebuild 失败时通知 `onError` 并保留最后一个成功 URL，不把半成品发布给 Tinypool。

runtime common 保留一个轻量、root-scoped Node worker artifact resolver。开发期 compiler 直接绑定该 resolver；没有
source binder 时，resolver 按注入的 artifact key 定位 packaged/static artifact。不要重新引入
`Context.runtimeDev.worker` 或通用 capability adapter。

### 运行时解析

同一 declaration 在三种环境下保持同一语义：

| 环境                           | artifact 来源                                        |
| ------------------------------ | ---------------------------------------------------- |
| dynamic/static Vite            | runtime-dev 编译 source graph，返回 cache-busted URL |
| dynamic 加载已发布 plugin      | 从 plugin package root 解析 `dist/workers/...`       |
| static production distribution | 从 deployment root/manifest 解析 frozen artifact     |

`bind()` 只交付 Node ESM URL 和更新事件，不创建 Tinypool、不定义线程数、不代理任务调用。worker execution 仍由插件
使用 Tinypool/worker_threads 并登记普通 effects cleanup；编译系统只拥有 declaration、artifact 和 HMR 生命周期。

### 删除内容

迁移完成后删除：

- `BundlerService`、`BundleJob` 和 generic browser/node bundling API；
- `bundle-worker.mjs` 及用于包裹 Vite build 的编译 Tinypool；
- runtime-dev/runtime-dynamic 两份重复 `moduleGraph.ts`，改用 Rolldown-owned source graph helper；
- `RuntimeDevCapabilities.worker` 和 dynamic host 的 bundler installation/cleanup；
- `worker()` 的 cwd/registry fallback resolution、`mode: 'fallback'` 和 inline fallback；
- 无消费者的 `@pluxel/runtime-dynamic/plugin` type alias entry；
- demo 中“生产环境自行预构建”的说明，改成同时验证 dev 与 packaged artifact 的真实示例。

不为旧 declaration 保留 compatibility wrapper；当前 major Changeset 承担迁移。

### 验收

- plugin package build 从 `worker.entry(import.meta.url, literal)` 生成稳定 key 的 Node ESM artifact，使用
  content-addressed build cache，并向 server declaration 注入相同 artifact key；
- static application distribution 包含所有可达 worker artifact，输出不引用 workspace source 或未解析
  `@pluxel/*` runtime import；
- headless 与 workbench distribution 对相同 worker declaration 生成相同 artifact，variant 只改变 UI closure；
- dynamic loader 能从已发布 plugin package 解析 packaged worker，而不要求 Vite server；
- static/dynamic Vite 修改 worker entry 或其依赖时只触发一次合并 rebuild，并发布新的 cache-busted URL；
- HMR compile failure 保留最后成功 worker，plugin replacement/stop 释放 watcher 和 update callback；
- Workbench disabled + worker enabled 不加载 Federation builder，二者都没有 declaration 时不创建 artifact cache；
- 搜索不到 `BundlerService`、`bundle-worker.mjs`、`watchTinypoolWorker`、`RuntimeDevCapabilities.worker`、
  `LoaderHmrWorker` 和两份 route-owned module graph helper；
- package build、static freezer、dynamic packaged resolution 和真实 Tinypool execution 都有端到端测试；
- 没有新增通用 artifact target registry、service manager 或部署端动态安装协议。

### 实施顺序与停止条件

1. 先在 Rolldown 增加 Node worker builder、artifact layout/validator 和 declaration extraction 测试；
2. 让独立 plugin package 与 static application 同时产出/记录 worker artifact；
3. 增加 runtime packaged/static resolver，确保无 Vite 环境能执行预构建 worker；
4. 把 runtime-dev compiler 的 graph/watch/cache coordinator 提取为两种具体 binding 共用的内部实现；
5. 迁移 dynamic/static Vite source binder 和 demo；
6. 最后删除 `BundlerService`、runtimeDev worker bridge、fallback 与 alias entry。

如果 Node worker builder 无法在不开放任意 external、不引入部署端安装的前提下产出可部署 closure，应停止并先
定义明确的 native dependency contract；不能以保留当前 dynamic-only fallback 作为完成。

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
- Node worker 迁移到 root artifact resolver 并删除 `RuntimeDevCapabilities.worker` 后，一并删除空的
  `RuntimeDevCapabilities`、`runtimeDevCapabilities()` 和 Context augmentation；
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
- 不用通用 artifact target/strategy registry 抹平 Workbench remote 与 Node worker 的输出 contract；
- 不把 Workbench collection、events 和 RPC 强行做成一个通用 transport abstraction；三者的 consistency 和 backpressure 语义不同；
- 不为删除的入口保留 alias。当前 major Changeset 已经承担 clean-slate surface cleanup。

## 实施顺序与停止条件

建议每项独立提交，并在删除后立即搜索旧符号。顺序上先完成 Node worker artifact pipeline 并删除旧 bundler
支线，再删除无消费者的 batch mirror，使 `runtimeDev` capability bag 整体消失；然后完成 builtin read-only
cut，最后才处理 internal barrel。

任一项遇到以下情况应停止并重新评估，而不是增加 adapter：

- 找到仓库外必须支持的明确 consumer；
- 删除会迫使 core 依赖 host/toolchain；
- static/dynamic 必须复制 lifecycle 才能完成迁移；
- disabled Workbench 在没有 UI declaration 时开始创建 UI backend、Federation compiler 或 watcher；
- 为保持兼容需要新增与旧概念等量的 facade。

完成某项后，应把稳定结论写入对应领域文档，并从本 proposal 删除已实现部分。
