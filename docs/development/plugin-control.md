---
title: 插件控制类型与实例调用
description: 使用构建生成的插件描述符、配置源码声明和实例类型，编写可检查的 Host 脚本。
---

插件构建会生成独立的 `control` 入口。入口里的值是冻结的数据描述符，携带插件的完整地址和配置、实例类型的摘要；类型文件保留原 class 的方法、属性、继承、重载与泛型。脚本通过 `sdk.plugin(Descriptor)` 选择插件，再使用同一个引用读取配置、启停节点或调用业务实例。

## 取得控制入口

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

`dev sync` 默认写入所选 Vite root 的 `.pluxel/control`。部署同步的默认目录相对于当前工作目录。部署命令输出 `entry`、`snapshot`、`catalogRevision`、`unavailableCount` 和 `definitions`；开发命令在 `{ ok: true, value }` 的 `value` 中提供相同字段。每项 definition 都包含完整地址、实际 `exportName` 和可导入的 `module` 路径。聚合入口为名称添加稳定的地址后缀；按输出导入，并在脚本内使用易读的局部名：

```ts
// 使用 sync 实际返回的 exportName；下面的后缀仅用于展示形式。
import { Counter_0123456789abcdef as Counter } from '../.pluxel/control/current/index.mjs'
```

同步先验证完整清单和每个文件，再原子切换 `current`。已有快照继续保留，当前导入不会看到半份材料。输出目录由工具管理；目录内已有作者文件或快照被修改时会报冲突。使用新目录或显式清理已经确认废弃的生成目录后再同步。

同步后的聚合入口只导出当前 catalog 已接纳的定义；底层声明闭包按已验证的原材料保留。`unavailableCount` 表示缺失、分析失败等尚不能提供材料的定义数量。已知分析失败或源码失配的原因显示在插件 `status()` 和全局 `plugins.list()` 的 `issues` 中；应用的配置读取和生命周期操作仍可通过动态地址进行。

## 选择插件与复用引用

`sdk.plugin()` 同步创建本次运行的插件引用，固定传入的地址和描述符摘要。它不查询 Host，也不启动插件。控制方法用闭包保存目标，可以直接提取工厂、配置对象或单个方法：

```ts
const plugin = sdk.plugin
const counter = plugin(Counter)
const { config } = counter
const { get, patch } = config
```

引用提供 `address`、`fork()`、`status()`、`start()`、`stop()` 和 `restart()`。生成描述符还提供 `instance()`，有配置的描述符提供准确推导的 `config`。运行时发现的完整地址使用同一入口：`sdk.plugin(node.address)`，配置字段保持未知数据。

异步控制操作统一返回共享 Better Result。`sdk.Result` 提供原生 namespace，单次操作可以直接作为脚本返回值；多步操作使用 `Result.gen` 和 `Result.await`，遇到 `Err` 即结束后续步骤。配置、日志和策略的原领域结果在 SDK 边界转换一次，成功值和错误没有重复的 `ok` 标记。完整错误及结果交付规则见[自动化脚本](./scripts.md#失败取消和释放)。

引用的使用期限由本次 run 管理。每次操作读取当前 Host 状态，重启后可以用同一引用重新取得业务实例；旧实例视图会失效。run 关闭后，缓存的工厂和 `fork()` 同步抛错，异步控制方法返回 `scope_closed` 的 `Err`。原插件业务方法仍遵守自身的返回类型和 JavaScript `this` 约定。

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
import type { Script } from '@pluxel/host/agent'
import { Counter } from '@acme/pluxel-plugin-counter/control'

export default (({ Result, plugin }) =>
	Result.gen(async function* () {
		const { get, patch } = plugin(Counter).config
		const before = yield* Result.await(get())
		const changed = yield* Result.await(
			patch(
				{ set: { count: before.config.count * 2 } },
				{ expectedManagedRevision: before.managedRevision },
			),
		)
		const actual = yield* Result.await(get())
		return Result.ok({ changed, actual })
	})) satisfies Script
```

`get` 返回 Schema 输出，`patch` 与 `validate` 接受 Schema 输入的递归 patch，数组整体替换。`managedInput` 和 `effectiveInput` 继续表达观察到的原始数据。`validate` 只预览候选输出；返回的 application 字段仍描述当前运行状态。保存与采用、版本冲突的处理见[自动化脚本](./scripts.md#读取计算条件修改与核对采用)。

已知无配置的描述符使用 `never` 输入和输出，对应引用没有 `config`。配置不同的目标联合只提供 `config.get()`；写入前先缩小描述符，再创建引用。擦除类型关联的描述符也不提供 typed 配置入口。运行时发现的 `PluginNodeAddress` 保留动态配置方法，配置字段为未知数据，调用方自行验证。

## 调用原插件实例

假设 Counter 的公开业务 API 包含 `increment(by: number)` 和可读属性 `calls`：

```ts
import type { Script } from '@pluxel/host/agent'
import { Counter } from '@acme/pluxel-plugin-counter/control'

export default (({ Result, plugin }) =>
	Result.gen(async function* () {
		const instance = yield* Result.await(plugin(Counter).instance())
		const changed = await instance.increment(3)
		return Result.ok({ changed, calls: instance.calls })
	})) satisfies Script
```

`counter.instance()` 要求节点已经运行，获取时不会启动它。`Result` 的成功值直接是实例，带有 `then` 成员的插件也能安全交付。未运行、目标失效和控制摘要不匹配等错误在返回类型中明确列出。实例保留原 class 的公共成员类型和可写性，私有与 protected 成员沿用 TypeScript 的可见性。通过原始地址选择的引用只有管理操作，业务实例访问需要生成描述符；Vite 项目还可以从当前 constructor 选择，见[项目脚本](./dev-console.md#编写可交互的开发脚本)。

实例视图限定在本次运行内，对象身份不同于原 provider；同一次运行内重复获取会复用视图。成员访问检查当前 scope 和 provider 的接纳状态，方法在原 provider 上执行，同步返回保持同步；标准 Promise 返回保持原对象并参与运行和 generation 的排空。重启后重新获取实例，缓存的旧成员调用会失败。

先 `await` 业务异步方法，再调用配置、策略、实例获取或插件启停等 Host 操作。这些操作与 provider 调用可能互相等待，SDK 会用 `borrowed_generation_conflict` 拒绝产生这种并发的调用。日志读取可以在业务等待期间进行。

方法返回的流、迭代器、自定义 thenable 和其他子资源遵循原业务 API 的释放协议。脚本用 `using`、`await using` 或 `try/finally` 释放它们；视图不会递归包装返回值。脚本返回 JSON 或共享的顶层 Result，其 payload 仍需是 JSON；实例和资源句柄留在执行进程内。

## 默认节点、fork 与更新

描述符选择默认节点。`fork()` 返回同一定义的另一个不可变引用；它替换 fork ID，原引用保持不变。以下片段用于应用已经声明并运行的 fork：

```ts
const counter = sdk.plugin(Counter)
const tenant = counter.fork('tenant-a')
```

选择 fork 不会创建或启动节点；它需要先由应用声明，再通过 `start()` 启动。`forkId` 沿用 Core 的非空标识规则。未知插件的发现继续使用 `plugins.list()` 返回的完整地址。日志使用原生过滤字段，例如 `{ filter: { plugin: tenant.address } }`。

typed 配置调用检查配置摘要，实例获取检查实例摘要。材料过期返回 `control_contract_mismatch`，在调用前重新同步并检查脚本。缺失材料返回 `control_material_unavailable`。执行前可从 `describe.capabilities` 确认 `plugin.instance` 能力；当前 Node、Vite 后端提供同进程实例访问。材料读取权限与脚本执行权限分别判断。

Vite 在原更新批次接纳候选后提供对应材料。修改源码时按[HMR 批次控制](./dev-console.md#hmr-批次控制)执行，成功 apply 后重新同步；未接纳源码不会成为在线描述符。上传与项目脚本都检查真实输入，拒绝声明与执行内容不一致的组合。提交、查询和取消仍使用原 [receipt](./scripts.md#向-node-应用提交)。
