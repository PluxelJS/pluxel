# Remaining Design Surface Reduction

状态：提案，尚未实现。

本文审计近期 core、runtime、static/dynamic route、Workbench 和 toolchain 重构后仍然存在的设计支线。目标不是进一步抽象，而是删除已经没有唯一职责、没有真实消费者或与当前权威设计冲突的概念。

## 结论

建议按以下顺序处理：

| 顺序 | 决策                                                | 置信度 | 主要收益                                         |
| ---- | --------------------------------------------------- | ------ | ------------------------------------------------ |
| 1    | 用 `defineNodeModule()` 声明额外 Node module        | 高     | 删除 worker-only bundler，并补齐 production 闭环 |
| 2    | 删除无消费者的 `runtimeDev.batches` mirror          | 高     | HMR API 不再复制进 runtime common capability bag |
| 3    | 把 builtin document 真正收窄为只读                  | 高     | 删除第二套表单、action 和 collection mutation UI |
| 4    | 收回 `@pluxel/runtime/shared` public-looking barrel | 中     | internal helper 不再伪装成稳定用户概念           |

第一项保留额外 Node 源码入口的编译能力，作者只看到 Node module 声明和使用，artifact 只是工具链内部术语；
同时删除 worker-specific 支线并复用现有 Vite/Rolldown artifact pipeline。第二、三项以
删除为主。第四项只有在不增加新的公开概念时才应推进。

## 1. 用 `defineNodeModule()` 声明额外 Node module

### 决策

保留插件声明“需要由 Pluxel 工具链单独构建的 Node 源码入口”的能力，但公开概念只叫 Node
module，不把内部的 artifact key、URL revision 或 binding lifecycle 暴露给作者。它不是插件在运行时传入
任意路径的 TypeScript compiler，也不代表 worker 或任务协议。

额外 Node module 与 Workbench UI 都是“server declaration 指向另一份源码图，开发期即时构建，生产期加载
预构建产物”，应共享 declaration extraction、源码图、hash/cache、watch/rebuild 和 atomic publication。
这些是实现共享，不是新的作者抽象。

共享发生在编译生命周期，不发生在输出格式：

```text
plugin source declaration
  -> canonical Rolldown declaration extraction
  -> source graph + build key + cache + atomic publication
       |-> Workbench UI builder -> browser Module Federation remote
       `-> Node module builder   -> single Node ESM artifact
```

不把 Node module 建模成 Workbench 子能力，也不把两个 builder 抽象成任意 target 的通用任务框架。

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
5. `pluxel build` 不提取旧 `worker()` declaration，插件 package 不输出对应 artifact；
6. static application freezer 不收集旧 `worker()` declaration 指向的 artifact，动态加载已发布插件时也没有
   packaged resolver；
7. static/non-HMR route 退回 inline fallback，导致相同插件在开发与生产采用不同执行模型。

问题不是 Node 源码入口不值得存在，而是当前 API 把“构建额外 module”误命名成“执行 worker”，且没有像
Workbench UI 一样成为 canonical toolchain artifact。

### 作者模型

唯一声明形式与普通使用形式为：

```ts
import { BasePlugin, defineNodeModule, Plugin } from '@pluxel/runtime'
import { Tinypool } from 'tinypool'

const taskModule = defineNodeModule(import.meta.url, './task.ts')

@Plugin({ name: 'TaskPlugin' })
export class TaskPlugin extends BasePlugin {
	private pool: Tinypool | undefined

	override async init() {
		await this.ctx.nodeModules.use(taskModule, async (url) => {
			const pool = new Tinypool({ filename: url.href })
			this.pool = pool

			return async () => {
				if (this.pool === pool) this.pool = undefined
				await pool.destroy()
			}
		})
	}
}
```

`defineNodeModule()` 只返回可静态提取的 opaque declaration；它不编译、不加载，也不需要作者传入
plugin ID。`ctx.nodeModules.use()` 是唯一使用动作：Context 直接提供 owner，成功 callback 返回当前消费者的
cleanup，不再要求作者手工保存 binding handle、读 snapshot 或订阅 `onUpdate`。

`use()` 的生命周期语义是：

1. 首次 source/packaged module 就绪后才调用 callback；`use()` 等待 callback 完成，首次构建或 setup 失败直接
   使 plugin `init()` 失败；
2. 开发期构建成功时，用新的 cache-busted `URL` 调用 callback；新 setup 成功后再清理上一个消费者，
   保持 last-known-good；
3. rebuild 失败或新 setup 失败时保留旧消费者并记录结构化错误，不需要每个插件重复 `onError`；
4. plugin replacement/stop 通过 owner effects 自动取消订阅并执行 active cleanup；作者不再调用 `dispose()`。

普通 ESM 使用同一个接口，不为 worker 另建 API：

```ts
await this.ctx.nodeModules.use(taskModule, async (url) => {
	const task = (await import(url.href)) as typeof import('./task.ts')
	return this.installTaskModule(task)
})
```

选择 `defineNodeModule` 是因为它对 agent 和作者都直说三件事：这是 declaration，目标是 Node，结果是可加载
module。不叫 `worker`，因为系统不创建线程；不叫 `compileTs`，因为输入也可以是 JS 且 production 不现场
编译；不叫 `nodeArtifact`，因为 artifact 是构建与部署实现，不是作者意图。
`Node module` 在此特指单独构建的 Node ESM entry，不是插件主模块，也不是 `node_modules` dependency。

`defineNodeModule` 从 `@pluxel/runtime` 主作者入口导出。原 `@pluxel/runtime/plugin` 只承载 worker facade，迁移后整个
subpath 删除，不再建立另一个 authoring entry。声明保持 module-level `const`，让工具链只识别显式导入的
`defineNodeModule(import.meta.url, <literal>)`，不猜测任意 `ctx` property access。

不把 module 重复写入 `@Plugin({ ... })`。Decorator 是 core graph metadata，Node module 是 runtime/toolchain 能力；
`ctx.nodeModules.use()` 已经提供了唯一 owner 和可达性事实，在 decorator 中再列一次只会制造两份来源。

公开命名只保留三个可理解概念：

| 作者意图             | 名称                    |
| -------------------- | ----------------------- |
| 声明额外 Node module | `defineNodeModule()`    |
| opaque 声明类型      | `NodeModuleDeclaration` |
| 在插件上使用 module  | `ctx.nodeModules.use()` |

consumer lease、revision 和 artifact key 均为 internal state，不再为它们定义公开类型；也不公开 manager、
adapter 或 target registry。

约束：

- entry path 必须是 string literal，第一参数必须是 `import.meta.url`；
- 一个插件允许多个 Node modules，internal artifact key 由 declaration module path + entry path 稳定生成；
- 输出 contract 只是可加载的单文件 Node ESM，不承诺 Tinypool、worker_threads、Web Worker、edge worker 或
  通用 job queue；
- artifact module 可以导出普通 ESM API；是否要求 structured clone 由 Tinypool/worker_threads 等具体消费者决定；
- declaration 不提供 `external` 和 inline fallback。Node builtins 由 builder 处理；无法安全 bundle 的 native/
  non-bundleable dependency 先明确报构建错误，不用开放式 external 绕过 production closure；
- module 缺失时 `use()` 失败，插件 `init()` 诚实失败，不静默切换为 inline execution。

### 统一构建管线

`@pluxel/rolldown` 的 canonical `createPluginBuildPipeline()` 安装一次 internal `pluginArtifactBuildPlugin`。该 plugin
在同一次源码 transform 中提取 Workbench UI 和 `defineNodeModule()` declaration，并分别调用两个具体 builder：

- `buildWorkbenchUiRemote()`：保留现有 browser Federation contract；
- `buildNodeModule()`：新增直接调用 `vite.build()`/Rolldown 的单文件 Node ESM builder。

二者共享：

- literal declaration extraction 与内部 artifact key 注入；
- Vite source graph collection；
- stable declaration artifact key、source/build signature 与 content-addressed build cache；
- 同一 artifact target 的 build 去重、staging、校验和原子发布；
- bounded historical artifact retention，保证 inflight UI import/Node module load 不因新版本发布立刻失效；
- plugin package 与 static application 使用同一 `createPluginBuildPipeline()`，不复制 lowering 规则。

二者不共享输出 validator、runtime manifest 或 target-specific Vite config。Module Federation 的 process-wide
exclusive section 只包围 UI builder；Node artifact build 不进入该临界区。

独立插件 package 输出：

```text
dist/
  index.mjs
  workbench/<ui-artifact>/...
  artifacts/node/<artifact-key>.mjs
```

static application freezer 把可达 Node artifacts 复制到 distribution，并把 artifact facts 写入现有 deployment
manifest。stable artifact key 标识 declaration，源码 hash 标识具体 build revision；不要把两者混成一个身份。
Node artifact 必须是自包含 ESM（Node builtins 除外）；不要新增部署端 package install 模式。只有声明 UI 或
`defineNodeModule()` 的 package 才加载对应 Vite builder；没有 declaration 时 canonical pipeline 不创建额外
输出目录。Node module 属于业务 runtime，不属于 Workbench variant；headless 与 workbench static distribution
都应收集可达 Node module artifacts。现有 `workbench: false` 只关闭 UI extractor/builder，不能顺带关闭 Node branch。

### 统一开发期 compiler

`@pluxel/runtime-dev` 允许每个 runtime root/Vite server 持有至多一个 internal `PluginArtifactCompiler`。它保留
两个具体 watch 入口：

```text
watchWorkbenchUi(owner, declaration, publish)
watchNodeModule(owner, declaration, publish)
```

内部共享 module graph refresh、watch set、hash、pending/inflight queue、cache retention 和 effects cleanup。目标构建
仍分别调用 `buildWorkbenchUiRemote()` 与 `buildNodeModule()`，不保留 `BundleJob` 或 strategy registry。

现有 `WorkbenchCompilerService` 迁移为该 concrete compiler，而不是在外面再包一层 manager。static/dynamic Vite
route 都调用一次 `attachPluginArtifactCompiler(ctx, viteServer, options)`，不再以 Workbench enabled 作为整个
attachment 的开关。attachment 只把 UI source provider 安装到已启用的 Workbench artifact service，并始终把
Node source provider 安装到 root `NodeModuleService`。两个 provider 共享一个 lazy `getCompiler()`；首个 UI/Node
declaration 被使用时才构造 compiler，完全没有 declaration 时只有两个轻量回调，不创建 compiler、watcher、
cache 或 target builder。cleanup detach provider，并只在 compiler 已创建时 dispose。所有 target-specific build code
保持在两个明确方法内，不注册 handler map。

compiler 必须按 declaration 懒启动：

- 没有 Node module declaration 时不创建 Node watcher、cache 或 build；
- Workbench disabled 时不安装 UI source provider、不加载 Federation builder；
- Workbench disabled 但插件使用 Node module 时，只构建 Node artifact；
- static Vite 与 dynamic HMR 都安装相同 Node module source provider，route 只提供自己的 Vite server；
- compile state 按 artifact key 去重，每次 `use()` 在内部建立 owner lease；多个消费者共用 watcher/build，但各自拥有
  setup callback 和 effects cleanup；
- 最后一个 lease 释放时停止 watcher；旧 owner cleanup 只能删除自己的 lease，不能移除 replacement 的 active lease；
- 旧成功 artifact 保留到 bounded cache cleanup；rebuild 失败时由 service 记录结构化错误并保留最后一个成功
  URL，不发布半成品 URL，也不重新调用 setup callback；

runtime common 只注册一个 concrete `NodeModuleService`。`ctx.nodeModules` 是现有 Context isolation 机制产生的轻量
plugin view，持有 owner Context；root 上的同类实例持有共享 declaration/lease state、唯一 dev source provider 和
packaged/static resolver。plugin view 直接调用 root 实例的内部方法，不再定义 service interface、adapter 或可变
“current Context”。

`NodeModuleService` 不暴露任意路径编译方法。有 dev source provider 时，它把 active declaration 交给
`PluginArtifactCompiler`；没有时按 transform 注入的 artifact key 定位 packaged/static artifact。不要重新引入
`Context.runtimeDev.worker`、`ctx.compiler` 或通用 capability adapter。

### 运行时解析

同一 declaration 在三种环境下保持同一语义：

| 环境                           | artifact 来源                                         |
| ------------------------------ | ----------------------------------------------------- |
| dynamic/static Vite            | runtime-dev 编译 source graph，返回 cache-busted URL  |
| dynamic 加载已发布 plugin      | 从 plugin package root 解析 `dist/artifacts/node/...` |
| static production distribution | 从 deployment root/manifest 解析 frozen artifact      |

`ctx.nodeModules.use()` 只把当前 Node ESM `URL` 交给 setup callback。插件可以 `import(url.href)`，也可以
把 URL 交给 Tinypool/worker_threads；编译系统不创建执行器、不定义线程数、不代理任务调用，只拥有
declaration、artifact 和 HMR 生命周期。具体消费者的 cleanup 由 callback 返回，然后并入 plugin owner effects。

### 删除内容

迁移完成后删除：

- `BundlerService`、`BundleJob` 和 generic browser/node bundling API；
- `bundle-worker.mjs` 及用于包裹 Vite build 的编译 Tinypool；
- runtime-dev/runtime-dynamic 两份重复 `moduleGraph.ts`，改用 Rolldown-owned source graph helper；
- `RuntimeDevCapabilities.worker` 和 dynamic host 的 bundler installation/cleanup；
- `worker()` 的 cwd/registry fallback resolution、`mode: 'fallback'` 和 inline fallback；
- 只承载 worker facade 的 `@pluxel/runtime/plugin`，以及无消费者的 `@pluxel/runtime-dynamic/plugin` alias entry；
- demo 中“生产环境自行预构建”的说明，改成使用 `defineNodeModule()` 和
  `ctx.nodeModules.use()`，并同时验证 dev 与 packaged module。

不为旧 declaration 保留 compatibility wrapper；当前 major Changeset 承担迁移。

### 验收

- plugin package build 从 `defineNodeModule(import.meta.url, literal)` 生成稳定 key 的 Node ESM artifact，使用
  content-addressed build cache，并向 server declaration 注入相同 artifact key；
- `ctx.nodeModules.use()` 首次使用失败会阻止 plugin 启动，更新失败保留上一个成功 consumer；
- static application distribution 包含所有可达 Node module artifacts，输出不引用 workspace source 或未解析
  `@pluxel/*` runtime import；
- headless 与 workbench distribution 对相同 Node module declaration 生成相同 artifact，variant 只改变 UI closure；
- dynamic loader 能从已发布 plugin package 解析 packaged Node module，而不要求 Vite server；
- static/dynamic Vite 修改 Node entry 或其依赖时只触发一次合并 rebuild，并发布新的 cache-busted URL；
- 同一 declaration 的多个 consumer 共用一次 compile/watch；HMR compile failure 保留最后成功 artifact；
- plugin replacement/stop 只释放对应 owner lease，最后一个 consumer 释放后才关闭 watcher；
- Workbench disabled + Node module used 不加载 Federation builder；二者都没有 declaration 时不创建 cache；
- 搜索不到 `BundlerService`、`bundle-worker.mjs`、`watchTinypoolWorker`、`RuntimeDevCapabilities.worker`、
  `LoaderHmrWorker` 和两份 route-owned module graph helper；
- package build、static freezer、dynamic packaged resolution、普通 `import()` 和真实 Tinypool consumption 都有
  端到端测试；
- 没有新增通用 artifact target registry、service manager 或部署端动态安装协议。

### 实施顺序与停止条件

1. 先确定 `defineNodeModule()` + `ctx.nodeModules.use()` 的 lowering 与 owner cleanup 测试；
2. 在 Rolldown 增加 `buildNodeModule()`、artifact layout/validator，让 plugin package 与 static application
   同时产出/记录 Node module artifacts；
3. 增加 `NodeModuleService` packaged/static resolver，确保无 Vite 环境能使用预构建 module；
4. 把 `WorkbenchCompilerService` 收敛为 `PluginArtifactCompiler`，让两种具体 source watch 共享
   graph/hash/cache；
5. 迁移 dynamic/static Vite source provider 和 demo；
6. 最后删除 `BundlerService`、runtimeDev worker bridge、fallback 与两个 plugin subpath。

如果 Node module builder 无法在不开放任意 external、不引入部署端安装的前提下产出可部署 closure，应停止并先
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
- Node module 迁移到 `NodeModuleService` 并删除 `RuntimeDevCapabilities.worker` 后，一并删除空的
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
- 不用通用 artifact target/strategy registry 抹平 Workbench remote 与 Node artifact 的输出 contract；
- 不把 Workbench collection、events 和 RPC 强行做成一个通用 transport abstraction；三者的 consistency 和 backpressure 语义不同；
- 不为删除的入口保留 alias。当前 major Changeset 已经承担 clean-slate surface cleanup。

## 实施顺序与停止条件

建议每项独立提交，并在删除后立即搜索旧符号。顺序上先完成 Node module pipeline 并删除旧 worker bundler
支线，再删除无消费者的 batch mirror，使 `runtimeDev` capability bag 整体消失；然后完成 builtin read-only
cut，最后才处理 internal barrel。

任一项遇到以下情况应停止并重新评估，而不是增加 adapter：

- 找到仓库外必须支持的明确 consumer；
- 删除会迫使 core 依赖 host/toolchain；
- static/dynamic 必须复制 lifecycle 才能完成迁移；
- disabled Workbench 在没有 UI declaration 时开始创建 UI backend、Federation compiler 或 watcher；
- 为保持兼容需要新增与旧概念等量的 facade。

完成某项后，应把稳定结论写入对应领域文档，并从本 proposal 删除已实现部分。
