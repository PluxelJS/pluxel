---
title: Host 服务组合与扩展
description: 使用官方服务预设快速搭建生产服务，或按需挑选服务与编写自定义服务扩展。
---

宿主（Host）除了托管插件的依赖图之外，还可以为插件提供统一的外部基础设施服务，如 HTTP、指令和 Workbench 管理面板。

Core 的 Context 直接提供 `ctx.logger`、`ctx.effects` 和 `ctx.events`。Plugin Context 另有 `ctx.fs()`、`ctx.tinybase`、`ctx.vault`、`ctx.wretch` 和 `ctx.fetch`，配置日志后的根 Context 另有 `root.logging`。应用通过 `coreConfig.zenfs` 选择文件后端，通过 `coreConfig.vault` 配置凭据后端，通过 `coreConfig.logtape` 配置日志。出站策略通过 `coreConfig.http` 声明。 [受管出站 HTTP](../plugin-development/outbound-http.md)

你可以直接使用官方推荐的 `servicesPreset()` 开箱组合，也可以根据特定需求按需挑选服务甚至编写自定义服务。

## 官方服务预设（servicesPreset）

官方提供的 `servicesPreset()` 会根据当前应用配置，返回完整的运行时服务列表：

```ts
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'

export default defineHostApplication(async (startup) => ({
	services: await servicesPreset(startup, {
		workers: { maxThreads: 4 },
	}),
}))
```

### 包含的服务模块

- **HTTP 路由**：挂载 Elysia 2 Web 框架，分发插件请求；
- **Commands 指令系统**：提供命令目录与调度能力；
- **Worker 线程池与 Node 模块加载器**：支持后台计算任务；
- **管理能力**：认证、运行状态、管理命令与管理 HTTP 入口；
- **Workbench 管理后台**：提供位于 `/__pluxel/workbench` 的可视化插件管理与调试页面。

应用按需为 `Pg` 和 `Sqlite` 安装驱动。[数据库服务装配](./configuration.md#数据库服务后端选择)

### 服务选项

省略选项或填写 `undefined` 时使用默认值。预设直接传递安装器选项，数组整体采用所提供的值。

| 字段             | 配置                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `product`        | 管理面与 Workbench 共用的 `ProductDescriptor`                                                                 |
| `nodeModules`    | `NodeModuleArtifactHostOptions` 中除 `root` 外的选项                                                          |
| `workers`        | `WorkersConfig`，包含原生 Worker 选项                                                                         |
| `management`     | `ManagementServiceOptions` 中除 `application` 和 `workbench` 外的选项                                         |
| `managementHttp` | `ManagementHttpOptions` 中除 `bindings` 外的选项，例如 `scripts: true`                                        |
| `workbench`      | `false`，或包含可选 `service` 和 `http` 的对象。预设负责服务的 `product`、`artifacts` 和 Shell 的 `publicDir` |

Standalone 由交付根目录派生 `artifacts/node`，modules 按已安装的插件 inventory 定位制品，Vite 默认接入源码编译器。显式 `nodeModules.resolve` 取代这些默认定位方式。Workbench Shell 的预设路径为 `/__pluxel/workbench`，可用 `workbench.http.uiBasePath` 设置。

<span id="初始侧栏入口"></span>

### 初始侧栏入口

在带有 Workbench 的应用中，你可以为用户首次打开界面时预设固定的侧栏快捷入口（例如将核心业务页固定在侧边栏）：

```ts
services: await servicesPreset(startup, {
	workbench: {
		service: {
			initialShortcuts: [{ target: OrdersPlugin.nodeAddress(), entryKey: 'overview' }],
		},
	},
})
```

- `target`：插件的节点地址；
- `entryKey`：插件在 Workbench 声明中定义的稳定视图键；
- 这些入口仅作为用户的初始布局推荐，用户后续可以自由在界面中取消固定或重新调整。

## 无界面应用与定制宿主

纯后台应用设置 `workbench: false`，保留 HTTP、Commands、Node、Worker 和管理能力。交付为 headless 时启用 Workbench 会报告缺少制品。

```ts
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'

export default defineHostApplication(async (startup) => ({
	services: await servicesPreset(startup, { workbench: false }),
}))
```

定制宿主与隔离测试直接组合所需的单项安装器，例如 `services: [elysia(), commands()]`，分别从 `@pluxel/services/elysia` 和 `@pluxel/services/commands` 导入。需要 Node 制品或 Worker 时再选择 `nodeModules()` 与 `workers()`；Worker 依赖 Node modules。Vault 是 Core 内建能力，其后端与部署配置见[凭据指南](../plugin-development/vault.md)。

## 自定义服务扩展

服务声明使用普通导出的 class 或 abstract class。实现与声明相同时可以直接使用 class；原生对象或第三方 API 可以用 abstract class 与 interface 合并表达类型，无需包装实例。

```ts
import { defineHostService, type HostService } from '@pluxel/host'
import { installOwnerViewService } from '@pluxel/core/host'

export class Counters {
	private readonly values = new Map<string, number>()

	increment(name: string) {
		this.values.set(name, (this.values.get(name) ?? 0) + 1)
	}

	read(name: string) {
		return this.values.get(name) ?? 0
	}
	clear() {
		this.values.clear()
	}
}

export function counters(): HostService {
	return defineHostService({
		name: 'Counters',
		provides: [
			installOwnerViewService(Counters, {
				createRoot: () => new Counters(),
				createView: (counters) => counters,
			}),
		],
		prepare({ ctx, effects }) {
			effects.defer(() => ctx.service(Counters).clear())
		},
	})
}
```

将 `counters()` 加入应用 `services` 后，插件通过 `this.ctx.service(Counters).increment('requests')` 使用已安装服务。Host 在接纳插件前执行 `prepare`，关闭或准备失败时释放登记到 `effects` 的资源。安装器工厂保持同步惰性；异步连接与 IO 放在 `prepare` 中，取得资源后立即登记释放。

通过文件运行应用的 Node 和 Vite Host 会在 `prepare` 参数中提供 `applicationEntry`。服务可以用实际入口定位应用包；直接以工厂或构造器建立的 Host 没有此字段。

HostService 的 `name` 用于诊断，`provides` 声明固定安装集合，`requires` 用直接导入的服务声明表达准备顺序：

```ts
const reporting = defineHostService({
	name: 'Reporting',
	provides: [],
	requires: { counters: Counters },
	prepare({ dependencies }) {
		dependencies.counters.increment('reporting.ready')
	},
})
```

缺少 provider、重复安装或准备依赖成环会在装配时失败；`requires` 不会自动安装服务。服务实例的缓存范围可选 root、scope 或 owner-view，访问权限可选 all、root 或 owner，详见 [Context host](../reference/context-hosts.md)。

## 必需服务与可选集成

`ctx.service(Service)` 直接返回必需服务，未安装时抛出 `ContextServiceMissingError`。可选集成使用导入的服务类型创建引用：

```ts
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import type { Workbench } from '@pluxel/workbench'

const WorkbenchRef = defineServiceRef<Workbench>()

@Plugin()
export class OptionalWorkbenchPlugin extends BasePlugin {
	protected override init() {
		const workbench = this.ctx.service(WorkbenchRef)
		if (!workbench) return
		// 使用 workbench 发布插件自己的界面。
	}
}
```

引用仅在服务未安装时返回 `undefined`；访问限制、构造失败及身份契约错误继续抛出。`defineServiceRef` 可省略：必需服务直接导入声明，不需要另一种定义写法。两种入口都只通过 `ctx.service` 解析。

服务身份由工具链根据声明的规范入口与具名导出生成。导出名、包或入口改变会改变身份；显示名称和任意字符串不参与匹配。

进程内脚本通过 `sdk.ctx` 使用内建能力，通过 `sdk.ctx.service(...)` 读取根服务；先 `const ctx = await sdk.plugin(address).context()` 再 `ctx.service(...)` 借用运行代的 owner 服务。远端编译只为应用安装的服务生成类型与契约材料，见 [Agent SDK](../development/agent-sdk.md)。

## 选择自定义服务还是插件

在消费方代码里，`ctx.service(Service)` 与构造函数注入插件看起来很像，但两者的生命周期与治理边界不同：

| 对比项       | 自定义 Host Service                                                                       | Plugin                                                                               |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 生命周期     | 绑定整个 Host 根；在插件启动前 `prepare()`，在所有插件停完后关闭，不支持独立启停或 HMR    | 位于 Core 依赖图内；支持独立启停、重启、动态加载与开发期 HMR                         |
| 故障影响     | 准备失败导致整个 Host 启动失败                                                            | 启动失败仅阻塞依赖它的下游插件，不影响无关节点                                       |
| 生态能力     | 通过安装器代码参数配置；无独立 Valibot 配置表单、托管数据库 owner 视图或 Workbench 发布页 | 直接使用 `configs.use()`、`envBindings`、托管 `Sqlite`/`Pg` 与 `WorkbenchRef` 管理页 |
| 多实例与替换 | 同一个服务声明在单个 Host 内全局唯一                                                      | 支持 `forkable` 多实例隔离、抽象插件令牌与按消费者覆盖实现                           |

**优先写成自定义服务**的场景：

- 需要按运行平台在启动边界注入原生能力、句柄或驱动（如 Cloudflare D1、Electron 主进程 API、HTTP 监听器）；
- 属于整个应用不可关闭的宿主底座，必须在所有插件启动前就绪，且不需要独立配置表单、管理页或热替换。

**优先写成插件**的场景：

- 业务领域或应用级能力（即使多个插件都会用到，如缓存、限流、权限、认证、对象存储）；
- 自身需要消费托管数据库、Valibot 受管配置或发布 Workbench 管理页面；
- 希望支持多种可替换实现、多实例隔离（fork）、动态安装，或借助依赖图在缺失/故障时精确阻断下游。

当宿主底座需要接入可替换的插件能力时，可以让自定义服务只定义极薄的协议插槽，再由具体插件在 `init()` 中向该服务注册实现并在停止时撤销（例如管理面认证由 `ManagementAccess` 服务提供插槽，具体登录流程与设置页由认证插件实现）。
