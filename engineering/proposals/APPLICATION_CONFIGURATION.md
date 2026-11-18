# 应用配置重设计

本文保留应用配置重设计的决策和迁移背景。当前机制与用法见 [Host](../HOST.md)、[Config](../CONFIG.md) 和[应用配置指南](../../docs/host/configuration.md)。

一次选择插件身份，在同一项写默认节点、fork、配置、绑定和启动意图。固定插件直接提供构造器，动态来源只负责发现实现，按地址的节点声明可以提前存在。应用通过同一份字段契约配置 Core 设施，通过唯一官方预设选择并配置额外服务。

## 应用声明

下面是适用于 Vite 和 modules 交付的拟议写法。`QueuePlugin` 允许 fork，`@example/billing/control` 提供一个按地址选择的插件引用。

```ts
import { resolve } from 'node:path'
import { BillingPlugin } from '@example/billing/control'
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'
import { QueuePlugin } from './plugins/queue'

export default defineHostApplication(async (startup) => {
	const root = startup.deployment?.root ?? startup.root
	const dataRoot = resolve(root, startup.env.PLUXEL_DATA_ROOT ?? '.pluxel')

	return {
		name: 'queue-app',
		inputMode: 'saved-first',
		plugins: [
			{
				plugin: QueuePlugin,
				autoStart: true,
				policyMode: 'declared-only',
				startTimeoutMs: 60_000,
				config: { queue: 'main' },
				forks: {
					east: { autoStart: true, config: { queue: 'east' } },
					standby: {},
					future: { deploy: false, config: { queue: 'future' } },
				},
			},
		],
		sources: [
			{
				directory: resolve(dataRoot, 'managed-plugins', 'entries'),
				include: ['*.mjs'],
			},
		],
		pluginNodes: [
			{
				definition: BillingPlugin.address(),
				config: { currency: 'TWD' },
			},
		],
		coreConfig: {
			logtape: {},
			vault: { deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY },
		},
		policy: {
			execution: { startTimeoutMs: 30_000 },
		},
		services: await servicesPreset(startup, {
			workers: { maxThreads: 4 },
			workbench: false,
		}),
	}
})
```

| 字段          | 职责                                                     |
| ------------- | -------------------------------------------------------- |
| `plugins`     | 提供精确的静态构造器及其节点声明                         |
| `sources`     | 从指定入口发现并加载实现                                 |
| `pluginNodes` | 按定义地址为由其他来源提供的实现预置节点声明             |
| `coreConfig`  | 配置 Core 内建设施                                       |
| `services`    | 安装额外服务                                             |
| `inputMode`   | 为配置和策略提供共同的来源优先级                         |
| `config`      | 设置节点配置的默认优先级和文档接线                       |
| `policy`      | 设置策略优先级、文档接线、执行参数和应用级 provider 选择 |

普通静态应用只需填写 `plugins`。仅由管理端操作动态节点的应用可以只声明 `sources`。`plugins`、`sources` 和 `pluginNodes` 省略时各自视为空。`name` 命名应用及根实例。`prepare`、`acceptStartup` 和 `launch` 分别负责启动前准备、启动结果判定和发布。

这套结构替换分散的实现清单、启动名单、`config.records` 与顶层绑定。已有调用能看到同一身份在不同入口重复出现。[脚手架](../../packages/create/template/host/src/policy.ts)、[示例应用清单](../../projects/plugin-host/src/showcase/catalog.ts)、[应用策略](../../projects/plugin-host/src/showcase/policy.ts)、[Invoice 应用](../../plugins/browser/invoice/examples/application.ts)

## 插件声明与地址

`plugins` 的每项是 `{ plugin: QueuePlugin, ... }`。Host 直接接纳该构造器，只有实现时写 `{ plugin: QueuePlugin }` 即可。`pluginNodes` 的每项是 `{ definition: address, ... }`，附带同样的节点字段。它只登记声明，实现尚未接纳时可保留输入并报告 unavailable。动态实现由 `sources` 加载。

类和生成的控制引用将 `definitionAddress()` 统一改名为 `address()`，返回结构化的 `PluginDefinitionAddress`。`nodeAddress()` 选择默认节点，`nodeAddress(forkId)` 选择 fork。抽象 token 用 `address()` 参与依赖选择。地址编码、持久身份和代际关系见 [Plugin Identity](../PLUGIN_IDENTITY.md)。

Host 在准备资源或异步读取部署输入前按规范定义地址检查声明。`plugins` 与 `pluginNodes` 跨表重复、同表重复及不符合声明角色的输入都报错，每个定义只有一份代码声明。构造器以原引用进入 candidate 接纳，目录加载的实现进入同一 catalog，冲突继续由 catalog 诊断。新旧构造器可以同时被各自的 Host 选择，数组位置只影响声明位置，启动顺序由依赖图决定。

### 默认节点与 fork

节点字段直接放在条目上。`forks` 按 fork ID 列出其他节点，Host 从定义地址生成每个完整节点地址。

| 字段                          | 含义                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `autoStart`                   | 该节点的主动启动意图。`false` 只关闭其主动启动，依赖仍可拉起它                                                    |
| `config`                      | 节点的原始配置声明，由 Core 按完整 schema 校验                                                                    |
| `configMode`                  | 节点业务配置的来源优先级                                                                                          |
| `policyMode`                  | 节点启动、fork 可用性及 consumer 覆盖的来源优先级                                                                 |
| `startTimeoutMs`              | 代码为该节点指定的启动期限，单位为毫秒                                                                            |
| `envBindings`、`fileBindings` | 节点自己的配置和 Vault 部署输入                                                                                   |
| `dependencyOverrides`         | 节点作为 consumer 时选择 provider。每项使用 `requirementAddress` 和 `providerAddress`，所在节点提供 consumer 地址 |
| fork 的 `deploy`              | 省略或 `true` 声明可用的 fork。`false` 表示只预置节点输入，创建权交给有效策略中的其他来源                         |

对 `forks` 表内的条目，省略 `config` 或提供 `undefined` 时，采用插件条目上直接写的 `config` 作为该 fork 的代码声明。例如 `standby` 取 `{ queue: 'main' }`。显式的 `config` 提供整份代码声明，`config: {}` 表示空声明。之后依次合成该节点的代码、file 和 env 输入，再按该节点配置 mode 与它自己的保存输入组合。

回退发生在解释应用声明时，范围是代码里的 `config` 数据。`configMode`、`policyMode` 和 `startTimeoutMs` 都只作用于所在节点。启动意图、绑定、凭据、依赖选择、保存输入和校验结果也各归各节点。管理端创建且没有代码条目的 fork 使用自己的输入。原来只依赖自身绑定、保存值或 schema 默认值的 fork 可显式填写 `config: {}` 迁移。

`deploy: false` 的代码条目可以预置配置、绑定、来源优先级和未来的启动期限，也可以显式关闭该节点的自动启动。它在代码层省略 fork 可用性选择。与 `autoStart: true` 或 `dependencyOverrides` 组合时报错。配置预置阶段按原规则读取并验证显式绑定，保存层在 mode 允许时可以部署此节点。`forks.remove()` 是独立的管理操作，负责停止、配置与服务及日志元数据清理和状态提交。fork ID、forkable 和引用约束使用现有身份及图校验。

`envBinding(inputs)` 和 `fileBinding(inputs)` 从所在节点取得 owner。保留 schema、mapping、path、Vault key 和 namespace 的既有输入及校验。file/env 的优先级、重叠诊断、来源核验及只读注入继续由 Host 处理。应用级 token 到 provider 的选择写在 `policy.providerDefaults`，当前 consumer 的例外写在其节点条目上。

## 动态来源

`sources` 的每项都是对象。`file` 与 `directory` 二选一，只有 `directory` 接受 `include`。

```ts
sources: [
	{ file: './src/queue.entry.ts' },
	{ directory: './src/plugins', include: ['**/*.entry.ts'] },
]
```

`file` 精确指定一个入口，缺失报错。`directory` 按非空的正向 `include` glob 匹配目录内的入口，目录尚未创建时视为尚无入口。路径可以是绝对路径或相对应用根目录的路径。Host 验证文件类型、路径范围和符号链接规则，合并重复入口。现有发布方的 `requirePluginSource()` 同样用此对象形状声明所需覆盖。Host 接纳时统一验证和快照，删除只用于封装这一步的公开 `pluginSource()` helper。[当前路径解析](../../packages/host/src/source-discovery.ts)、[发布覆盖](../../plugins/package-manager/src/index.ts)

路径、glob 和来源数组由 `defineHostApplication(startup)` 的普通 TypeScript 代码计算。可以用 `resolve()`、环境变量、条件和 `map()`，工厂返回完成求值的数据。Host 以本次声明选定的入口为准。共享发布路径可以用普通常量表达。路径变化经应用工厂重求值接纳，来源文件变化使用本次已接纳的来源规则。

Vite 开发时可加载经过语义处理的 TypeScript 入口和预编译 ESM，监听匹配文件的新增、替换和删除。Node 原生启动及 modules 交付在启动时加载匹配的预编译 `.js` 或 `.mjs`，之后发布在下次启动采用。standalone 交付要求固定闭包，允许省略 `sources` 或直接填写 `[]`。发现使实现进入 catalog，自动启动与否由有效策略决定。[HMR](../HMR.md#固定-catalog-与可选动态来源)、[原生加载器](../../packages/host/src/native-source-loader.ts)、[交付](../APPLICATION_BUILD.md)

## 输入优先级与策略

应用可以只写一次 `inputMode`。各域依下表从左到右选取首个已指定的 mode。

| 输入         | 优先级从高到低                                                                     |
| ------------ | ---------------------------------------------------------------------------------- |
| 节点业务配置 | `节点.configMode → config.mode → inputMode → declared-first`                       |
| 节点策略     | `节点.policyMode → policy.modes[field] → policy.mode → inputMode → declared-first` |
| 应用级策略   | `policy.modes[field] → policy.mode → inputMode → declared-first`                   |

节点级 `policyMode` 用于该节点的 `autoStart` 和 fork 可用性，也用于其作为 consumer 的 `dependencyOverrides`。应用的 `providerDefaults` 和 `execution` 使用应用级优先级。`policy.modes` 按实际策略字段取 mode，例如 `autoStart` 或 Host 默认的 `startTimeoutMs`。这些优先级由代码配置，文档的 `readOnly` 和管理权限另行决定写入是否允许。

`declared-only` 只选择代码输入。`declared-first` 让代码优先，保存值补缺。`saved-first` 反过来。节点配置继续按现有叶路径合并。每项策略按下表的粒度比较声明与保存输入。

| 策略                                | 选择粒度                                 | 显式输入与缺省                                                                                       |
| ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 自动启动 `autoStart`                | 节点地址                                 | `true` 或 `false`。省略表示该来源未作选择，两层均缺省时该节点不主动启动                              |
| fork 可用性 `forks`                 | fork 节点地址                            | 代码中可部署的条目提供 `true`，仅预置项省略可用性选择。保存层以 `true` 或 `false` 表达创建或移除意图 |
| consumer 覆盖 `dependencyOverrides` | consumer 节点地址和 requirement 定义地址 | provider 节点地址或 `null`。`null` 回到正常的 provider 选择，省略表示该来源未作选择                  |
| `providerDefaults`                  | 应用的完整列表                           | 由 `policy.providerDefaults` 声明，例如显式 `[]` 是有效输入                                          |
| `execution`                         | 各项执行设置                             | 按实际字段选择，缺省由 Core 提供                                                                     |

示例中 Queue 默认节点用 `policyMode: 'declared-only'` 从代码取得启动意图，其业务配置仍按 `saved-first` 选择。它的 fork 各自解析 mode。在 `declared-first` 下，代码只对 A 写 `autoStart: false` 时，Workbench 已为 B 保存的自动启动意图仍有效。空的 `forks` 表提供零个选择项。

有效策略生成协调器所需的启动根、可用 fork 和依赖选择，再核验 fork 引用。结构矛盾报告为错误，合法但实现未发现报告为 unavailable。当前 policy 按整列选择，本提案为节点策略改用逐键选择。[现有策略计算](../../packages/host/src/state-store.ts)

### 启动期限

启动 generation 时，Core 按下列顺序取第一个已提供的期限。

1. Host 代码在该节点条目上写的 `startTimeoutMs`。
2. 插件定义的 `@Plugin({ startTimeoutMs })`。它适用于默认节点和各 fork，在相应节点省略本地期限时采用。
3. 当前 Host 已采用的 `policy.execution.startTimeoutMs`，缺省由 Core 提供。

毫秒期限使用 Core 的共同校验，范围为 `1` 到 `2_147_483_647` 的整数。应用节点、Host 默认、直接 Core 和 `@Plugin()` 使用同一规则，非法显式输入在进入运行时前报错。迁移时为现有装饰器补齐上界校验。

Host 按节点地址快照代码中的期限，通过内部执行接线交给 Core。Core 启动 lifecycle 时为该 generation 固化有效期限，定义元数据提供该定义的默认值。应用节点条目的变化随应用工厂重求值后的 Host 采用。插件定义的期限随候选接纳进入下一 generation，已开始的启动按本代期限结算。

Workbench 管理 Host 默认执行参数，节点期限由应用代码声明。`policy.modes.startTimeoutMs` 选择 Host 默认期限的来源。

`policy.execution` 的 `startConcurrency` 和 `stopConcurrency` 是 Host 共享的并发预算，`drainTimeoutMs` 是 Host 的排空期限。节点条目只开放启动期限。[插件装饰器](../../packages/core/src/plugins/decorators/PluginDecorator.ts)、[生命周期计时](../../packages/core/src/plugins/runtime/plugin-service/LifecycleManager.ts)

### 管理和保存

保存策略只记录有明确选择的键。`autoStart` 记录节点地址与布尔值，`forks` 记录 fork 地址与布尔值，`dependencyOverrides` 记录 consumer、requirement 与可空的 provider 地址。各列表按规范地址排序，同一个选择键只出现一次。关闭自动启动写该节点的 `false`，清除 consumer override 写该项的 `null`，reset 删除对应的保存条目以恢复继承。

管理命令和批量修改只改目标键。`forks.ensure()` 在同一事务处理部署、可选自动启动及 consumer 选择。`forks.remove()` 先验证有效策略与引用，再走现有停止、清理和保存流程。普通的启停和重启属于会话意图，编辑持久自动启动只改变启动策略。[现有节点策略修改](../../packages/host/src/state.ts)、[fork 事务](../../packages/host/src/forks.ts)

Workbench 按实际目标展示采用的 mode、来源、遮盖状态及写权限。撤销恢复修改前的原始状态，包括原先没有保存记录的情况。实际动作被代码遮盖时仍在副作用前拒绝，原始策略编辑可以保存被遮盖的值。版本冲突、保存未知、已采用结果和生命周期失败继续分开报告。Host 默认执行输入保存为新目标后，已采用的设置由 Host 重建切换。

`config.document` 和 `policy.document` 各自配置文档接线。默认借用 Core FS，持久性由 ZenFS mount 决定。`false` 关闭该域的文档 IO，保留会话输入。`{ readOnly: true }` 限制管理写入。`{ storage }` 在 root 创建后调用一次同步 factory，返回的 storage 由 Host 借用。config 域订阅外部文档并校验，policy 域在启动时读取。缺失文档保持缺失，坏文档报告错误并保留文件。优先级、写权限和文档接线分别表达。[现有配置与保存](../CONFIG.md)

## Core 配置与管理能力

Host 在 `coreConfig` 直接接收 Core 定义的设施字段 `logtape`、`zenfs`、`tinybase`、`vault` 与 `events`。Core 导出共同的 `CoreFacilitiesConfig`，`CoreHostConfig` 在此基础上包含 `name` 和 `execution`。直接使用 Core 的调用方可以填写 `execution`。Host 从 `policy.execution` 和保存策略解析并一次绑定相同的执行类型和默认值。旧 Core `plugins` 执行字段迁移为 `execution`。

Core 在创建 root 前验证并快照选项，之后按能力自己的准备和关闭流程处理资源。应用直接填写 ZenFS mount 和 `durableMounts`。LogTape 选项如下。

| `logtape` 输入                  | 行为                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| 省略                            | `ctx.logger` 可用，Core 不安装日志管理器                   |
| `{}` 或 `{ options }`           | 使用现有控制台及有界日志缓存预设，可配置 Core 日志管理选项 |
| 原生 Config 或同步 root factory | 采用原生配置，替换默认 preset                              |
| `{ input, options }`            | 指定原生输入和管理选项                                     |

应用的设施配置类型从 Core 或对应领域入口导入，移除公共 `@pluxel/core/config` 和 `logtape()`、`zenfs()` 两个声明 helper。Core 处理设施的默认值、校验与资源生命周期，保留上游 callback 和资源借用契约。

`ctx.logger` 用于插件写日志。配置 LogTape 后，`root.logging` 提供日志策略、缓存、状态及 flush，Core 负责安装和关闭。`ctx.vault` 是插件内建的凭据视图，凭据契约、隔离与存储归 Core。应用用 `coreConfig.vault` 选择后端和部署身份，`coreConfig.zenfs` 选择文件后端。Host 读取并验证节点的 env/file 绑定，再以只读记录注入 Core。Vault 后端按需初始化，锁定、缺少匹配密钥、解密失败、只读及缺记录由实际操作报告。[日志](../LOGGING.md)、[Host 凭据接线](../HOST.md#vault-记录与宿主输入)

## 官方服务预设

`servicesPreset(startup, options = {})` 是唯一官方组合入口。预设把应用选项交给现有安装器，复用其原生类型，保留 callback、联合分支与 WorkerOptions。预设拥有共享品牌、服务连接和固定交付制品路径。

| 预设选项         | 采用的类型及预设负责的字段                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product`        | `ProductDescriptor`，供 Management 和 Workbench 共用                                                                                                             |
| `nodeModules`    | `NodeModuleArtifactHostOptions` 中除 `root` 外的选项                                                                                                             |
| `workers`        | `WorkersConfig`                                                                                                                                                  |
| `management`     | `ManagementServiceOptions` 中除 `application` 和 `workbench` 外的选项                                                                                            |
| `managementHttp` | `ManagementHttpOptions` 中除 `bindings` 外的选项                                                                                                                 |
| `workbench`      | `false` 或 `{ service?, http? }`。`service` 使用 `WorkbenchInstallOptions`，排除 `product` 和 `artifacts`。`http` 使用 `WorkbenchShellOptions`，排除 `publicDir` |

省略或 `undefined` 采用服务预设默认。提供的字段替换对应默认，数组整体替换，callback 保持原对象。预设拥有的字段在创建资源前校验。无参数的安装器直接使用既有默认。

仅 standalone 从交付根派生 Node 的 `artifacts/node`。modules 通过各插件的已安装 inventory 定位，Vite 默认接入源码 compiler。显式 `nodeModules.resolve` 完整替换默认定位策略，预设不再注入 `root`，确保 resolver 确实被调用。

Workbench 默认开启，Shell 路径缺省 `/__pluxel/workbench`。`workbench: false` 跳过 Workbench 相关服务、Shell 和管理绑定，继续安装 Management。交付为 headless 时请求 Workbench 会报告制品冲突。旧 `workbench: true` 迁移为省略或 `{}`，布尔选项依此转换。旧 `scripts` 迁移到 `managementHttp.scripts`，`initialShortcuts` 迁移到 `workbench.service.initialShortcuts`。

定制的服务组合用各个安装器配置，Database 显式选择后端并安装。`vitePreset` 负责开发附件及开发控制台，不重复配置正式服务或远程 scripts 授权。正式监听由 `launch` 接入，Vite 承载自己的开发监听。[现有预设](../../packages/services/src/preset.ts)、[服务接线](../../docs/host/services.md)

## 构建、接纳与迁移

Host 在每次应用工厂求值后归一化声明，先保留固定构造器与规范地址，再登记加载来源、控制材料和制品归属。应用驱动发现动态入口，接入同一 catalog。Host 建立唯一 root，读取和合并保存输入，一次绑定 execution，再准备服务、启动节点、判定和发布。`createHost()`、浏览器和测试 Host 使用同一声明归一化规则，文件发现由具备此能力的应用驱动负责。

standalone 固定清单识别静态可解析的 `{ plugin: Constructor, ... }` 条目，设施及节点配置值由运行时工厂选择。构建分析从明确的类导入、控制引用和节点声明提取生成制品及 env 模板所需的事实。`pluginNodes` 的地址只为节点选择提供身份。modules 和 Vite 在运行时接纳来源的计算结果。需要生成模板的绑定使用静态可分析的 schema 和映射，也可针对动态定义，候选实现到达时核验契约。构建阶段只分析声明和元数据，无法证明所需事实时报出对应表达式。[构建解析器](../../packages/rolldown/src/rolldown/plugins/staticConfigEnvironment.ts)

Vite 在应用工厂变化时重新计算并接纳应用，非工厂的来源更新提交 catalog 事务。正常替换与失败保留、补偿和 generation 排空使用现有接纳边界，各 Host 按自己的 catalog 选择版本。来源回归应验证构造器层和实际已运行状态，而非仅比较文件列表。

### 策略数据迁移

启动、fork 和 consumer 覆盖的保存输入从当前 v7 的整列格式迁到逐键记录。显式转换工具读取旧声明和保存值，盘点已有节点及暂未发现实现的有效地址，比较转换前后的有效策略。旧列表中的正项可以直接转换。已知目标曾被另一层的完整列表压住时，转换需在对应层明确表达该目标的关闭或清除，或由维护者选择目标语义。这三项的旧空列表对所有未来地址的隐含否决无法转换成有限记录，这是逐节点契约的有意变化。无法等价的结果列出待审差异，确认后再写入目标文档。

配置文档继续使用现有节点地址与原始记录，保留相同格式。新运行时只读取新策略格式，迁移由单独工具完成。管理输入、来源投影和 Workbench 编辑器同步到新格式，有效 graph 和生命周期回执继续走现有协调路径。

### 代码与文档迁移

| 范围                  | 必须同步                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Core 与生成控制入口   | `address()`、`execution`、期限校验及逐代采用、共用设施类型与领域导出，删除旧方法及 `@pluxel/core/config` |
| Host 与管理端         | 声明数组、`pluginNodes`、来源类型、节点绑定和期限、逐目标优先级及编辑回执，删除旧作者字段                |
| 构建与驱动            | 固定清单分析、env 模板和控制材料、standalone/modules、Vite 来源发现、发布覆盖和失败恢复                  |
| Services 与 Workbench | 逐项原参数、headless、回执和清除／继承语义                                                               |
| 已知调用方            | 实际应用、插件示例、隔离测试、SDK、构建 fixtures 与发布方，删除旧调用形状                                |
| 脚手架与文档          | Create/CLI 的生成内容、README、AGENTS、完成提示以及受影响的 `docs/` 和工程领域页                         |

删除旧 `runtime`、裸 constructor 数组、作者 `config.records`、顶层绑定、`policy.autoStart/forks/dependencyOverrides`、旧 `policy.mode` 映射、旧来源形状和旧预设参数。旧公共入口随着调用方同步替换，内部构造器清单与有效图快照继续用于框架接线。交付说明和版本由规定的发布流程处理。

## 完成条件

- 静态构造器、按地址预置项及来源候选在真实 Host 中采用一致的规范身份。重复的代码声明给出两个声明位置，提前配置动态目标时能证明其业务实现由来源接纳。
- 验证默认节点及多个 fork 的省略配置、显式空配置、独立配置、未部署预置，以及包含 env/file 和 Vault 输入时的节点隔离。
- 验证代码只修改 A 时 B 的保存选择仍生效，也验证节点的 `policyMode` 独立覆盖全局规则。检查显式关闭、清除、reset、保存后重开，以及保存层和代码的来源显示、撤销和失败回执。
- 通过真实节点启动和超时回执验证节点期限、定义期限、Host 默认及 Core 默认的取值顺序。覆盖同一插件的默认节点与 fork 期限不同、同一构造器在两个 Host 期限不同，以及非法期限在资源准备前拒绝。
- 真实 Vite 使用计算路径观察 TS 或预编译 ESM 入口，验证新增、替换、删除与候选拒绝。独立安装的 modules 在启动时发现实现，standalone 采用固定声明并拒绝动态来源。
- 验证直接 Core 和 Host 对相同设施字段采用一致行为，默认和自定义 LogTape、ZenFS、Vault 只读绑定、日志管理和关闭排空都经过实际入口。
- 验证逐项预设参数与 resolver 确实被使用，headless 具备管理能力。生成项目、文档、公开导出和已知调用方全部采用目标契约。
