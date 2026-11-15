---
title: 插件控制类型与实例调用
description: 使用构建生成的插件描述符、配置源码声明和实例类型，编写可检查的 Host 脚本。
---

插件构建会生成独立的 `control` 入口。入口里的值是冻结的地址提供者，提供 `definitionAddress()` 和 `nodeAddress(forkId?)`。它们携带构建绑定的类型与校验信息，类型文件保留原 class 的方法、属性、继承、重载与泛型。脚本通过 `sdk.plugin(Descriptor.nodeAddress())` 选择插件，再使用同一个引用读取配置、启停节点或调用业务实例。

## 取得控制入口

发布生成的 `./control` 时，插件包须在 `peerDependencies` 显式声明兼容的 `@pluxel/host`，因为标准地址方法使用共享的 Host 工厂。仅此入口需要 Host 时，将该 peer 标为 optional；其他运行入口也使用 Host 时保持必需。开发构建在 `devDependencies` 安装兼容版本。构建会拒绝缺失 peer、仅 devDependency 或嵌套运行依赖，不会修改这些声明。脚本作者安装匹配目标平台的 Host；控制入口不加载插件实现。

独立插件包经 `pluxel build` 构建后，从它的 `./control` 导出导入描述符：

```ts
import { Counter } from '@acme/pluxel-plugin-counter/control'
import type {
	CounterConfigInput,
	CounterConfigOutput,
	CounterConfigDeclaration,
	CounterInstance,
} from '@acme/pluxel-plugin-counter/control'
```

插件包模式的实例类型引用原包的公开 class 声明，作者安装该包及原 API 使用的公开类型依赖。应用和 Vite 默认携带本地应用声明闭包，作者取得材料后无需应用源码，仍需安装声明引用的公开外部类型包；同步命令不安装依赖。公开类型引用 JSON 时，作者项目需要启用 `resolveJsonModule`。闭包内部保留原 class 的私有名义关系，它与另行安装的实现包声明属于各自的模块身份。生成失败会使构建失败，并指出无法处理的声明。

原插件包和公开类型依赖的版本应与材料生成环境匹配。同步不安装、锁定或核验这些外部依赖版本；材料完整性与配对声明检查只验证交付材料，本地不同版本的外部声明仍可能推导出不同的成员类型。此要求同样适用于应用声明闭包保留的外部类型引用。

声明生成要求相关模块的公开类型可被 TypeScript 命名。若插件与应用工厂在同一文件，工厂返回具体服务类导致 `TS2883` / `TS4094`，为回调声明 `: HostApplication` 或 `: Promise<HostApplication>` 返回类型。这样应用保持明确的公开返回类型，插件成员继续保留自身的完整声明。

对运行中的应用，可以通过现有认证连接读取它已接纳的材料：

```sh
# 使用 dev status 已选择的 profile；有多个匹配实例时再加 --instance。
pluxel dev sync --profile app

# 部署应用沿用 Management 管理认证，读取无需开启 scripts。
pluxel script sync --endpoint https://app.example.com \
  --credentials-file ./admin.json --out .pluxel/control
```

`dev sync` 默认写入所选 Vite root 的 `.pluxel/control`。部署同步的默认目录相对于当前工作目录。两种同步命令均在 `{ ok: true, value }` 的 `value` 中返回 `out`、`snapshot`、`catalogRevision`、`unavailableCount` 和 `definitions`。每项 definition 都包含完整地址、实际 `exportName` 和可导入的 `module` 路径。同步按权威入口生成稳定模块，同一入口的插件共享模块，普通具名导出沿用原名。不同包的同名插件通过模块路径区分。使用返回的准确 `module` 与 `exportName` 导入；特殊导出名或类型名冲突的实际名称也以该输出为准：

```ts
// 使用 sync 实际返回的 module；下面的目录摘要仅展示路径形式。
import { Counter } from '../.pluxel/control/current/entries/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/index.mjs'
```

同步先验证完整清单和每个文件，再原子切换 `current`。已有快照继续保留，当前导入不会看到半份材料。输出目录由工具管理；目录内已有作者文件或快照被修改时会报冲突。使用新目录或显式清理已经确认废弃的生成目录后再同步。

同步模块只导出当前 catalog 已接纳的定义；底层声明闭包按已验证的原材料保留。`unavailableCount` 表示缺失、分析失败等尚不能提供材料的定义数量。已知分析失败或源码失配的原因显示在插件 `status()` 和全局 `plugins.list()` 的 `issues` 中；应用的配置读取和生命周期操作仍可通过动态地址进行。

## 选择插件与复用引用

`sdk.plugin()` 同步创建本次运行的插件引用，固定传入地址所绑定的声明证据。它不查询 Host，也不启动插件。控制方法用闭包保存目标，可以直接提取工厂、配置对象或单个方法：

```ts
const plugin = sdk.plugin
const counter = plugin(Counter.nodeAddress())
const { config } = counter
const { get, patch } = config
```

引用提供 `address`、`status()`、`start()`、`stop()` 和 `restart()`。把 definition 交给 `@pluxel/agent-sdk/source` 的 `inspectPlugin` [定位作者源码](./inspection.md)。选择 fork 使用 `Counter.nodeAddress('east')`，同样交给 `sdk.plugin()`。

`sdk.plugin(counter.address)` 保留原有类型与调用证据，可以在另一个 run 中重新选择。新引用的寿命属于新 run，保存地址不会延长旧引用或实例的寿命。

源码 class 地址提供原实例类型与动态 `config`，配置字段为未知数据。生成入口提供精确的配置输入／输出类型；已知无配置的插件不开放 `config`。

通用工具可从 `@pluxel/agent-sdk/host` 导入 `PluginInstance<TAddress>`，同时提取源码地址和生成地址关联的实例类型。先保存 `const node = Counter.nodeAddress()`，再用 `PluginInstance<typeof node>` 提取具体实例。`PluginConfigInput<TAddress>`、`PluginConfigOutput<TAddress>` 继续用于生成地址，保留 Schema 输入与输出的对应关系。

| 地址来源                           | 使用位置                     | 类型信息                              |
| ---------------------------------- | ---------------------------- | ------------------------------------- |
| 生成入口的 `nodeAddress()`         | 上传脚本和 Vite 项目脚本     | 配置输入/输出、声明源码和业务实例类型 |
| 原 Plugin class 的 `nodeAddress()` | 同一 Vite 模块图中的项目脚本 | 原 class 实例类型、未知字段的动态配置 |
| 运行时发现的 `node.address`        | 上传脚本和 Vite 项目脚本     | 动态配置与生命周期                    |

直接 import class 时，脚本和 Host 必须使用同一个已加载的 constructor。包管理器的独立安装目录可能与项目 `node_modules` 中的副本不同。HMR 后旧 class 地址返回 `stale_target`，重新导入当前实现再取得地址。class 的使用条件由目标 Vite 模块图决定，见[项目脚本](./dev-console.md)。

类型与运行时证据绑定到原始不可变地址。直接传递、保存变量、引用的 `.address` 和选择 fork 都保留它；spread / `Object.assign` 后的副本会明确报错。JSON 往返和 `parsePluginNodeAddress()` 得到普通身份地址，用于动态管理；实例调用需要重新从原提供者取得地址。TypeScript 断言无法恢复实例能力。

脚本直接返回原地址、把它放入普通对象或 Result 时，执行器也只交付纯身份，接收方不会得到调用证据。地址提供者和原地址对象可以跨 run 持有；SDK 引用与实例视图仍属于各自的 run。

异步控制操作返回 `Promise<Result<T, E>>`，可以直接作为脚本返回值。多步调用使用 async/await，在 `isErr()` 分支提前返回，从 `value` 读取成功值。配置、日志和策略的原领域结果在 SDK 边界转换一次，保留原字段并去掉重复的 `ok` 标记。完整用法和失败处理见[自动化脚本](./scripts.md)。

引用的使用期限由本次 run 管理。每次操作读取当前 Host 状态，重启后可以用同一引用重新取得业务实例；旧实例视图会失效。run 关闭后，缓存的 SDK 选择工厂同步抛错，异步控制方法返回 `scope_closed` 的 `Err`。原插件业务方法仍遵守自身的返回类型和 JavaScript `this` 约定。

## 地址、契约摘要与升级

描述符通过规范地址定位插件。独立包的 definition 由包名、公开入口和具名导出组成；本地应用的入口由逻辑 source space 与源码路径表示，同样按具名导出区分 definition。node 地址再区分 default 或具体 `forkId`。构建产物保留这些地址，安装目录、npm 版本和本次构建摘要不进入插件身份。跨应用的同名地址由目标连接与执行实例区分。

配置和实例摘要用于检查脚本声明与当前实现的兼容性，材料 `snapshot` 标识一组文件。升级可保持地址；摘要失配的类型化配置或实例操作返回 `control_contract_mismatch`，重新同步并检查脚本后再操作。选择具体二进制版本由包管理器的安装选择负责。

## 动态安装后的发现与操作

[包管理器](../plugins/package-manager.md)将安装结果发布到配置的目录来源。Vite 接纳相应 HMR 批次后，新 definition 进入当前 catalog；Native 运行时按其 `next-start` 规则在下次启动加载。安装回执、Host 接纳和插件启动分别核对。

使用 `sdk.plugins.list({ packageName })` 定向发现包中的节点，已知完整 definition 时使用 `{ definition }`；已有节点地址则直接 `sdk.plugin(address)`。成功值为 `{ nodes, catalogRevision, runtimeStateRevision, nextCursor }`。列表包括已接纳但尚未启动的 default 节点、已配置的 forks，以及仍被配置引用的不可用节点。以下脚本返回指定包的一页可用插件：

```ts
import type { Script } from '@pluxel/agent-sdk/host'

export default (async (sdk) => {
	const page = await sdk.plugins.list({ packageName: '@acme/pluxel-plugin-counter' })
	if (page.isErr()) return page
	return {
		...page.value,
		nodes: page.value.nodes.filter(({ availability }) => availability === 'available'),
	}
}) satisfies Script
```

每页默认 50 项，`limit` 最大 200；未指定筛选的 `list()` 同样只返回一页。将非空 `nextCursor` 原样交给相同查询的下一次 `list({ ..., cursor })`，直到返回 null。cursor 可以在同一 Host 的后续 run 中继续，不保留资源；Host 被替换、查询、catalog/runtime revision 或节点身份序列变化时返回 `cursor_stale`，从第一页重查。每页重新读取当前运行状态，跨页不是一个 Host 事务，不缓存先前页的状态。两个 revision 保持各自领域含义；跨调用关联同步材料时核对 catalog revision，变化后重新读取。

一个包可以提供多个同名导出入口，每个 definition 也可以有多个节点；按完整 `definition` 和 `variant` / `forkId` 选择，不能只按展示名判断。对选定节点调用 `sdk.plugin(node.address)` 即可查询声明、读配置或启停；运行状态为 stopped 时也可发现它。业务实例需要先启动节点。

要查看安装清单，读取 PackageManagerPlugin 原生 `snapshot()` 的 `packages`。Host 列表以插件节点为单位，安装包可以包含零个或多个插件；`execution.kind === 'vite'` 且 `execution.origin === 'source'` 表示 Vite 动态来源，也包含其他目录来源。

首次安装且作者尚无类型时，分两次编写脚本：先安装并确认 Host 接纳，然后执行 `dev sync` 或 `script sync`，从实际返回的 `module` / `exportName` 导入新描述符，再调用 `sdk.plugin(Descriptor.nodeAddress()).instance()`。TypeScript 在执行前检查，首次发现的未知类型通过这次同步提供。作者已有匹配版本的包控制入口时，可以直接使用它的描述符。同步读取当前 catalog，Vite 的后续动态来源同样参与。

包缺少合法控制材料时，同步结果会报告 `unavailableCount`；此时仍可按地址进行动态配置与生命周期管理。生成材料中的公开外部类型依赖仍需在作者环境提供匹配版本。

## 声明中的注释

控制材料的声明生成始终保留公共 JSDoc，独立于作者用于其他构建产物的 `removeComments` 设置。class、成员、继承声明和关联类型中的说明、`@param`、`@returns`、`@example`、`@deprecated` 等注释随原声明交付。生成入口的描述符和实例类型也附上原 class 文档，配置类型说明输入、验证后的输出以及对应源码描述。

只修改本地声明的说明文字会更新材料快照，同时保持配置和实例类型摘要。作者的 `stripInternal` 设置继续生效。插件包模式保留原公开 class 身份，其成员的类型提示使用原包发布的声明文档；控制材料同时携带可阅读的本地声明。生成器保留原有说明，不推测缺失的业务语义。

## 配置输入、输出与源码表达式

假设插件使用以下 Schema：

```ts
const CounterConfig = v.object({
	count: v.optional(v.pipe(v.number(), v.minValue(0)), 2),
})
```

生成的 `CounterConfigInput` 允许省略 `count`，`CounterConfigOutput` 则包含已经补齐的数值字段。`CounterConfigDeclaration` 是只读的源码描述类型，记录每个配置节点的 `path`、`source`、`className`、`expression` 和引用的 `dependencies`。声明旁的注释也保留 Schema 表达式、本地常量、helper 声明和直接引用的 JSON 数据，所以编辑器和 agent 能看到默认值、校验器、转换以及 Part 的配置位置。

这些源码描述不会作为 JavaScript 执行，也不会读取运行环境里的值。真正的校验、来源合成、保存和运行采用继续由目标 Host 的原 Schema 完成。

描述符让 SDK 自动关联输入和输出类型：

```ts
import type { Script } from '@pluxel/agent-sdk/host'
import { Counter } from '@acme/pluxel-plugin-counter/control'

export default (async ({ plugin }) => {
	const { get, patch } = plugin(Counter.nodeAddress()).config
	const before = await get()
	if (before.isErr()) return before
	const changed = await patch(
		{ set: { count: before.value.config.count * 2 } },
		{ expectedManagedRevision: before.value.managedRevision },
	)
	if (changed.isErr()) return changed
	return get()
}) satisfies Script
```

`get` 返回 Schema 输出，`patch` 与 `validate` 接受 Schema 输入的递归 patch，数组整体替换。`managedInput` 和 `effectiveInput` 继续表达观察到的原始数据。`validate` 只预览候选输出；返回的 application 字段仍描述当前运行状态。保存与采用、版本冲突的处理见[自动化脚本](./scripts.md#读取计算条件修改与核对采用)。

已知无配置的描述符使用 `never` 输入和输出，对应引用没有 `config`。配置不同的目标联合只提供 `config.get()`；写入前先缩小地址类型，再创建引用。擦除为 `PluginTypedNodeAddress` 的地址也不提供 typed 配置入口。运行时发现的 `PluginNodeAddress` 保留动态配置方法，配置字段为未知数据，调用方自行验证。

## 调用原插件实例

假设 Counter 的公开业务 API 包含 `increment(by: number)` 和可读属性 `calls`：

```ts
import type { Script } from '@pluxel/agent-sdk/host'
import { Counter } from '@acme/pluxel-plugin-counter/control'

export default (async ({ plugin }) => {
	const instance = await plugin(Counter.nodeAddress()).instance()
	if (instance.isErr()) return instance
	const changed = await instance.value.increment(3)
	return { changed, calls: instance.value.calls }
}) satisfies Script
```

`counter.instance()` 要求节点已经运行，获取时不会启动它。`Result` 的成功值直接是实例，带有 `then` 成员的插件也能安全交付。未运行、目标失效和控制摘要不匹配等错误在返回类型中明确列出。实例保留原 class 的公共成员类型和可写性，私有与 protected 成员沿用 TypeScript 的可见性。通过原始地址选择的引用只有管理操作，业务实例访问需要生成入口的原始地址；Vite 项目还可以使用当前 class 的原始地址，见[项目脚本](./dev-console.md#编写可交互的开发脚本)。

实例视图限定在本次运行内，对象身份不同于原 provider；同一次运行内重复获取会复用视图。成员访问检查当前 scope 和 provider 的接纳状态，方法在原 provider 上执行，同步返回保持同步；标准 Promise 返回保持原对象并参与运行和 generation 的排空。重启后重新获取实例，缓存的旧成员调用会失败。

先 `await` 业务异步方法，再调用配置、策略、实例获取或插件启停等 Host 操作。这些操作与 provider 调用可能互相等待，SDK 会用 `borrowed_generation_conflict` 拒绝产生这种并发的调用。日志读取可以在业务等待期间进行。

方法返回的流、迭代器、自定义 thenable 和其他子资源遵循原业务 API 的释放协议。脚本用 `using`、`await using` 或 `try/finally` 释放它们；视图不会递归包装返回值。脚本返回 JSON 或共享的顶层 Result，其 payload 仍需是 JSON；实例和资源句柄留在执行进程内。

## 默认节点、fork 与更新

`Counter.nodeAddress()` 选择默认节点，`Counter.nodeAddress('tenant-a')` 选择同一定义的 fork。它们只生成不可变地址，fork 需要先由应用声明，再通过引用的 `start()` 启动。以下片段用于应用已经声明的 fork：

```ts
const counter = sdk.plugin(Counter.nodeAddress())
const tenant = sdk.plugin(Counter.nodeAddress('tenant-a'))
```

`forkId` 沿用 Core 的非空标识规则。动态发现继续使用列表中的完整地址。日志使用原生过滤字段，例如 `{ filter: { plugin: tenant.address } }`。

typed 配置调用检查配置摘要，实例获取检查实例摘要。材料过期返回 `control_contract_mismatch`，在调用前重新同步并检查脚本。缺失材料返回 `control_material_unavailable`。执行前可从 `describe.capabilities` 确认 `plugin.instance` 能力；当前 Node、Vite 后端提供同进程实例访问。材料读取权限与脚本执行权限分别判断。

Vite 在原更新批次接纳候选后提供对应材料。修改源码时按[HMR 批次控制](./dev-console.md#hmr-批次控制)执行，成功 apply 后重新同步；未接纳源码不会成为在线描述符。上传与项目脚本都检查真实输入，拒绝声明与执行内容不一致的组合。提交、查询和取消仍使用原 [receipt](./scripts.md#向-node-应用提交)。
