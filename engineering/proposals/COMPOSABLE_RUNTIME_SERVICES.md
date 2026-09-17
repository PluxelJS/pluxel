# 可组合服务、Host 管理面与共享 Workbench

状态：设计提案，尚未实现。本文统一服务类型、静态安装、管理面、Workbench 与开发接入的设计方向。
示例中的名称、包路径和签名均为设计示意，不是当前可用 API。本文不改变当前实现、包版本或用户用法。

当前事实以 [工程原则](../DESIGN_PRINCIPLES.md)、[插件系统](../PLUGIN_SYSTEM.md)、[Runtime](../RUNTIME.md)、
[配置](../CONFIG.md)、[HMR](../HMR.md) 与 [开发控制台](../DEV_CONSOLE.md) 为准。
本文提出的作者类型与包边界调整，需要实现和验证后才能成为新的工程约束。

## 1. 目标与核心决策

外部应能组合官方服务、添加自己的服务，同时直接复用通用管理面、官方 Workbench 和满足服务要求的官方插件。
不使用数据库时不安装数据库，无需从完整 Runtime 中通过 `{ database: false }` 做减法。
外部可以封装自己的 Runtime 包，但创建一个新的 Runtime 作者体系不是复用这些能力的前置要求。

采用一条组合路径：

1. Plugin 统一基于 Core；服务包提供服务 API 和类型声明。
2. 服务包增强服务类型目录，不把服务声明成所有 Context 必然拥有的字段。
3. Host 在 root 创建前显式安装固定能力集合；import 不安装服务。
4. Plugin 对可选服务直接检查；必需服务通过 `ctx.require(Token)` 取得非可选返回值，不升级整个 Plugin 的 Context 类型。
5. management 和 Workbench 复用同一套实现；独立 Runtime 作者体系收敛为官方默认 Host 组合，使用与外部相同的公开接线。
6. 服务专属管理页面由普通管理 Plugin 发布；服务 backend 不依赖 Workbench，不新增服务页面发布者或管理贡献 registry。
7. 每个服务默认只有一个公开入口，同时导出 token、类型和安装器；依赖隔离先在内部实现，不机械拆分作者/安装子路径。
8. 开发和构建采用官方 Vite/tsdown 配置与普通插件列表；官方和外部声明工具链沿相同公共接入，Pluxel 统一管理 artifact 与发行组装。

服务可选安装不等于服务运行期热插拔，也不承诺任意第三方实现都可替换官方服务。
Plugin 间业务依赖继续使用 constructor 与 optional Plugin ref，不通过服务读取绕过 Plugin graph。

### 最小公共面与各自的使用者

| 使用者                | 必需的公开机制                                    | 不需要承担                                     |
| --------------------- | ------------------------------------------------- | ---------------------------------------------- |
| Plugin/Part 作者      | Core 基类、服务 token、`ctx.require()` 与可选属性 | 服务安装、构建会话、依赖声明列表               |
| 服务作者              | token、固定安装计划、已声明依赖、领域 backend     | 动态服务发现、页面注册体系、通用 provider 选择 |
| 管理页面作者          | 普通 Plugin 和现有 Workbench 声明/客户端          | 新的服务 publication owner                     |
| 源码转换作者          | 普通 Rolldown/Vite hooks，可选 AST helper         | Artifact 注册、握手或版本协议                  |
| 额外产物作者          | 正常构建 hooks；按需交付产物及其依赖/完成结果     | 第二套插件语言、通用编译工作流                 |
| Host/application 作者 | 运行组合声明、标准 Vite/tsdown 插件列表           | 手动拼接官方 compiler、第二个 server entry     |

新增公共机制必须能指出表中的实际使用者。内部源码缓存、队列、候选标记和完成协调不因需要复用就全部导出。

### 代表性验收

同一个 TypeScript 项目验证两个 Host：A 安装 Persistence、Vault 与 Workbench，B 不安装 Vault，二者均不安装数据库，
并显式提供各自需要的管理接入/carrier。可顺序创建并关闭，以保留当前进程 logging 的单 active root 约束；
类型检查同时覆盖两份声明，不借该样例承诺多个官方 logging root 同时运行。
同一个官方 Vault 插件在 A 运行，在 B 明确报告服务缺失，其他无依赖关系的插件仍正常工作。
外部再安装自己的 Search 服务、业务插件和管理插件，通过官方 Workbench、管理 RPC 和同实例 console 完成操作。
停止 Search 管理插件只撤回页面与其交互 API，Search 服务及无依赖关系的业务插件继续工作。

独立 tarball 安装工作区还应证明：外部组合无需依赖 `@pluxel/runtime`，实际选中入口不带入数据库实现，
开发与生产共享服务及 Core identity。官方默认 Host 必须使用同一公开组合路径。

## 2. 现有基础与变化范围

当前 Runtime 已经通过 `declare module '@pluxel/core'` 增强类型，再通过静态 installation 编译实际 Context shape。
保留现有 Context kernel、严格惰性、root/scope/owner-view 分工、generation effects 和固定生命周期阶段。

需要改变的是集中式 Runtime 契约：导入一个包会带入整套服务类型，部分服务被声明为所有 Context 必然拥有。
新设计将服务契约、安装实现与官方组合分开，让插件兼容性由实际服务要求决定，而非由平台包名决定。

| 层                              | 责任                                                                 | 不承担                                     |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| Core                            | Plugin 作者模型、graph、generation、配置事实、服务类型目录与受控读取 | IO、服务安装策略、管理 UI                  |
| Core 的宿主组合入口             | 固定 Core 能力与附加 installation 的受控组合                         | 默认作者入口中的资源安装、运行期改 shape   |
| Host                            | 生命周期、catalog、来源会话、运行意图、协调器、通用管理操作          | 默认安装数据库、业务 HTTP 或 Workbench     |
| 管理接入及浏览器入口            | 认证、RPC、会话、订阅、输入校验、客户端                              | 第二份领域逻辑、任意代码执行               |
| 服务入口                        | token、类型增强、安装器与服务配置；内部隔离 backend 和准备实现       | import 时创建资源、隐式安装无关服务        |
| 服务管理 Plugin                 | 取得所需服务、发布专属页面与显式交互 API                             | 安装/关闭被管理服务、绕过宿主授权          |
| Workbench                       | 插件发布与交互、artifact 接入、官方 UI                               | 强制安装整套官方 Runtime 服务              |
| Host-dev                        | 单一 ModuleRunner、更新队列、当前 Host 会话、console                 | 官方服务集合                               |
| Services 根入口的默认 Host 组合 | 常用官方服务、管理 Plugin、持久化默认、启动与发行接线                | 独立 Runtime 作者模型、另一套管理/HMR 实现 |

表中是职责边界，不是逐项新增包的要求。`@pluxel/services/vault` 等路径表示拟采用的组织方式，最终 exports 仍需发行验证。

### 一个服务入口，内部隔离实现

```ts
// Plugin：取得 token 与服务类型。
import { Vault } from '@pluxel/services/vault'

// Host 组合：从同一入口取得安装器。
import { vault } from '@pluxel/services/vault'
```

同入口导出不等于自动安装。token 定义与 backend 放在不同内部模块，入口保持无资源副作用；
安装器调用只生成声明，资源在 Host 管理的创建/准备阶段产生。第一版不规定每个服务都有 `/host` 或 `/install/*`。

原生 ESM 会加载静态依赖，不能以“没有调用安装器”或“bundler 可以 tree-shake”证明未加载重型实现。
需要隔离的 backend/驱动可由安装计划在异步准备阶段加载；轻量实现可直接静态引用，不强制每个服务增加动态 import。
`ctx.require()` 保持同步：需要异步加载的代码与资源必须在 Host 准备期间就绪，不能在首次 Plugin 读取时返回 Promise。
准备后的 owner-view 仍可保持既有同步惰性构造与缓存。

单个服务入口不得反向导入默认组合根入口或全部服务 barrel。浏览器入口继续隔离 Node 与安装实现，
声明产物不能因导出 token 就要求消费者解析无关驱动或前端库。若真实导入/声明验证证明单入口无法保持必要边界，
再针对该服务拆入口或包，不预先给所有服务增加同一套路径。

分别验证无资源副作用、实际模块加载、构建产物和包管理器安装闭包；四者不能互相替代。
同包子入口不保证包管理器不下载同包声明的依赖，数据库等重依赖是否独立发包，以独立安装证据确定。

### Runtime 收敛为官方默认 Host

目标架构不再保留 `@pluxel/runtime` 作为独立作者契约或运行内核；其领域实现进入相应服务，
管理和开发职责进入 Host/Host-dev，剩余便捷接线归入 `@pluxel/services` 根入口的官方默认组合。
该组合优先提供给标准 application 声明使用，使用公开服务安装器和普通管理 Plugin，
显式提供常用文件持久化、管理面、Workbench 及选定的常用能力。先验证声明表达，再固定导出名称与配置签名。
默认组合是明确的产品清单，不是自动安装所有官方服务；新增一个官方服务不会自动增加所有默认宿主的资源成本。
需要用户秘密、外部连接或特殊资源预算的服务不能靠虚构配置安装；默认清单及所需输入应在实现时逐项确定。

需要另一种组合时，从 `@pluxel/host` 和具体服务入口构建正向清单，不为默认组合加入一长串关闭开关。
外部平台也可封装组合函数，无需另建 Plugin 基类或一套 ambient Runtime 类型。
服务专属管理 Plugin 仍在各自 Plugin 包根入口导出，官方 application/starter 显式引用它们，不把 Plugin 塞入服务子入口。
Services 默认接线不反向依赖消费它的管理 Plugin 包，避免形成 `services → admin-plugin → services` 的包发布环。
默认体验由可见的服务组合与固定 Plugin imports 一起完成，不通过服务根入口隐藏 Plugin catalog。
默认组合和自定义组合共享 application 声明、Vite 驱动及生产启动路径，不引入第二个 server entry 或发行协议。
不先增加独立 `createDefaultHost()` 工厂再补第二套构建声明；程序式启动使用已有 Host 创建路径消费同一组合。
组合允许复用，但必须明确哪些 fixed Plugin imports 进入发行闭包、启动配置何时解析，以及无关服务为何不进入产物。
当前 freezer 对 application/环境绑定有语法约束，任意 object spread 或工厂调用不自动视为可分析；
必须通过官方与外部默认组合的开发/生产切片后，才能承诺相应写法。

移除原 Runtime 包是后续实现迁移结果，不是本轮已发生的事实；迁移覆盖既有导入、toolchain、test/dev/web 入口和生产映射，
不只移动根入口或更改包名，也不永久保留旧 Runtime 作者路径作为并行体系。

## 3. 类型：已知服务与已安装服务分离

服务入口增强开放的类型目录，例如：

```ts
// @pluxel/services/vault；VaultStorageApi 由本入口定义或导出。
declare module '@pluxel/core' {
	interface ContextServices {
		vault: VaultStorageApi
	}
}
```

目录只回答“这个服务名对应什么 API”。它不是运行时 registry，不注册 provider，也不证明当前 Host 已安装服务。
类型声明进入同一个编译环境会影响所有模块，因此不能直接将其映射成所有 Context 的必选属性。

| 使用边界                          | 类型保证                                            |
| --------------------------------- | --------------------------------------------------- |
| 通用 Plugin Context               | Core 固定能力必选；当前作用域允许的已知附加服务可选 |
| 从安装集合推导的具体 Host/Context | 静态可证明已安装且作用域合法的服务必选              |
| 动态构造或已拓宽的安装集合        | 只保证类型能证明的部分，不强制断言完整 shape        |

类型投影必须保留 root、generation 和 owner-view 的不同可用范围。安装 Elysia 不代表 root 获得 generation application；
安装 Vault 不代表 Plugin 获得 root 管理权限。`ctx.root`、caller view 和 Part 也不能成为扩大服务访问面的捷径。
具体采用分作用域目录还是带作用域信息的统一目录，留待类型切片验证，但不能退化为一张无作用域的万能映射。

安装集合在 root 创建时固定。外部可定义自己的服务类型目录项，服务名不能覆盖 Core 固定成员，包括 `require`。
类型目录只是属性投影的词汇表，不能作为能力身份或授权证明。

### Token、属性名与同名冲突

服务入口导出轻量的 opaque capability token，例如 `Vault`；同入口的安装器引用同一个 token。
token 承载服务值类型和合法作用域，复用既有 descriptor 身份，不新增字符串 registry 或第二套 capability 系统。
声明 token 不构造 backend。默认投影属性 `vault` 与 token 的绑定由服务契约固定，安装器不能随意改写。

| 情况                                           | 规则                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| 同一个 token 重复安装                          | 计划验证拒绝，不按先后覆盖，也不猜测两份配置相等                     |
| 不同 token 使用同一属性名                      | 计划验证拒绝，不因类型形状相似而视为兼容                             |
| 使用相同显示名称或诊断标签                     | 不构成身份相同；诊断需要区分实际来源                                 |
| 插件持有的 token 与安装 token 不同             | 不按属性名回退读取；报告未提供该能力，并在可判断时附带身份不匹配诊断 |
| 覆盖 Core 成员或把 root-only 能力投影给 Plugin | 计划验证拒绝                                                         |

冲突采用两道防线：`createHost()` 的类型约束检查静态可判定的安装列表，拒绝可证明的重复 token、重复属性与保留成员冲突；
列表拓宽、JavaScript 或类型断言可能绕过静态检查，因此运行时始终先验证完整计划。
当前 kernel token 类型主要表达值类型，并非每次创建都获得不同的 TypeScript nominal identity；
两个同型 token 不能仅靠条件类型可靠区分。静态检查优先使用可保留的属性字面量/身份信息，
不为声称编译期完全覆盖而要求作者手工维护第二套 token ID。运行时 object identity 和属性检查是最终防线。
任何实际安装冲突都必须在创建 root、调用服务工厂和启动资源之前拒绝，并指出冲突成员与安装来源。
不依赖 ambient 声明合并来证明安装无冲突。Plugin 自己读取未安装能力的时机另见下节。
第一版不提供应用侧任意别名、自动替换或按版本范围动态选择实现。

还有一个独立限制：ambient 声明在整个 TypeScript program 内合并，即使两个服务不会安装在同一 Host，
它们声明的同名属性也可能产生类型冲突。不同类型的重复声明通常被 TypeScript 拒绝；类型相同并不证明契约身份相同。
第三方属性使用带组织/领域辨识度的名字，token 解决必需读取的身份问题，不会自动消除可选属性的全局命名冲突。

## 4. Plugin 的服务使用契约

可选 Workbench 保持直接、可读的调用：

```ts
import '@pluxel/services/workbench'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class ExamplePlugin extends BasePlugin {
	protected override async init() {
		this.ctx.workbench?.publish(/* 既有 Workbench declaration */)
	}
}
```

必需服务使用受控读取，获得非可选类型：

```ts
import { Vault } from '@pluxel/services/vault'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class CredentialsPlugin extends BasePlugin {
	protected override async init() {
		const vault = this.ctx.require(Vault)
		// vault: VaultStorageApi；使用当前 owner 的能力。
	}
}
```

两段代码仅示意作者形态。Side-effect import 的职责是引入作者契约，其运行时代码不得安装资源。
发布声明和打包后的插件必须保留所需服务类型引用，不能只依赖 monorepo 中偶然存在的 ambient declarations。

`ctx.require(Token)` 只接受对当前作用域合法的 capability token，按身份解析当前 Context 的已安装能力；
允许沿既有严格惰性规则首次构造服务 view，但不安装缺失服务、不查找 Plugin provider、不修改 shape。
未安装时抛出稳定的服务缺失错误；已安装服务的构造或业务异常不伪装成“未安装”。
返回值直接从 token 推导，无需调用方补泛型或断言。底层复用现有 capability resolver，
不通过 token 的属性名读取另一个实现。类型擦除、JavaScript 或断言不能绕过运行时作用域和 token 有效性检查。

`require` 不采用 `asserts this is ...`，不收窄整个 Plugin 类的 `this.ctx`，也不同时提供独立的 `requireService` alias。
取得返回值后直接使用 `vault`；其他方法及其他 owner 的 Context 类型不因此改变。
可选属性保持 `ctx.workbench?.publish()`，暂不新增 get/has/optional 方法组。

第一版不增加 Plugin services 列表，不扫描 `ctx.xxx` 自动推导依赖，也不把 import 当成必需服务声明。
缺失检查发生在实际读取时，不承诺在 constructor 或任何副作用之前发现全部服务要求。
推荐在 init 开头取得必需服务；init 失败复用已有 lifecycle report、dependent blocking 和 effects cleanup。
管理面可以报告实际观察到的缺失服务，不能声称列出了插件的完整静态需求。

可选服务缺失返回 undefined，已安装但准备失败不等于可选缺失。服务 handle 仍遵守 owner admission 与撤回规则；
读取成功不是永久有效性保证，也不授予任意 root 或其他 Plugin 的权限。

### PluginPart 与缓存

PluginPart 使用相同调用：

```ts
class CredentialsPart extends PluginPart<MyPlugin> {
	protected override async init() {
		const vault = this.ctx.require(Vault)
		// 按该 Part 的 Context 解析，不借用父 Plugin 的 owner-view。
	}
}
```

root backend 可以共享，generation scope backing 沿用既有规则；owner-view 则分别缓存 Plugin、Part 和 caller view 的身份。
同一个 owner 重复 require 应复用既有缓存；不能为了查服务先转到 `ctx.root`，或把父 Plugin 的 view 注入 Part 冒充其自身能力。
Part 缺失必需服务沿现有 Part init 失败规则使 owning Plugin 启动失败，已创建资源进入原有清理路径。

跨方法需要复用时可以保存当前 owner 的 handle，但不能跨 generation 保存或借此绕过撤回。
`private readonly vault = this.ctx.require(Vault)` 的字段初始化形式暂不作为保证的示例：
需验证 Plugin/Part 字段初始化前的 Context 绑定和构造失败清理，再决定是否正式支持。
默认推荐 init 中取得局部返回值，不增加 assertion API 或服务绑定 DSL 来模拟永久类型升级。

## 5. Host 正向安装与资源所有权

宿主组合的调用形态如下；配置、省略的 carrier/storage 接线及确切签名由真实调用点验证：

```ts
import { createHost } from '@pluxel/host'
import { persistence, fileStorage } from '@pluxel/services/persistence'
import { vault } from '@pluxel/services/vault'
import { workbench } from '@pluxel/services/workbench'
import { search } from '@acme/services/search'
import { SearchAdminPlugin } from '@acme/search-admin'

const host = await createHost({
	services: [
		persistence({ backend: fileStorage({ directory: './data' }) }),
		vault({/* 显式配置 */}),
		workbench({/* 显式配置 */}),
		search({/* 显式配置 */}),
	],
	plugins: [CredentialsPlugin, SearchPlugin, SearchAdminPlugin],
})
```

安装函数生成声明与配置，不在函数调用时创建资源。没有 database 安装项就没有 database 能力，
不创建 backend、连接、watcher 或清理任务；不以空服务模拟成功安装。
官方组合可以封装这张清单，但可组合入口不继承一个需要逐项关闭的全量默认集合。

Host 顺序固定为：

1. 验证应用、固定 catalog 与完整安装计划，拒绝重复、冲突、缺失宿主依赖及循环；此处只验证声明，不导入 backend 来探测资源。
2. 编译固定 Context shape，创建 root；每份资源成功创建后立即登记 cleanup。
3. 准备配置/状态存储和显式需要 preflight 的服务，按依赖顺序完成准备。
4. 接纳 catalog、启动 Plugin；局部 Plugin lifecycle issue 如实形成报告。
5. 宿主接入层绑定开发附件和管理端点，全部成功后才向外开放对应会话；普通无附件 Host 不等待这一步。

宿主资源准备失败清理已创建资源，不发布半初始化 Host。准备依赖不自动安装 provider，缺失时要求组合作者明确提供。
例如 Vault 的持久化接线需要梳理并显式表达，不能通过其安装器偷偷带回完整 Runtime 或数据库。
顺序由声明的宿主依赖确定，无依赖项以声明顺序保持确定性；这里只建立一次性准备关系，不建立第二套动态 Plugin graph。

Host 拥有 root、coordinator、source 会话和 generation。关闭先停止新接纳、撤回附件与会话，排空已接纳操作，
停止 generation，再释放服务资源。依赖者先清理，provider 后清理；清理失败仍继续其余清理并聚合报告。
`close()` 幂等并复用完成结果。端点单独关闭不关闭 Host。

Host 通过固定安装计划创建 root，不同时公开 services 与任意 root factory 两条可替代路径。
内部 factory 在交付前负责自身失败清理，交付后由 Host 独占关闭责任；不接管已运行 root 或绑定第二个 coordinator。

### 服务依赖与实现多态

安装器以 capability token 声明必需依赖，同一份声明同时用于类型化注入、计划校验和准备顺序；
服务实现不再重复声明列表或按字符串查找。以下仅示意接线语义，具体定义 helper 和签名由两个实际服务验证：

```ts
const vaultInstallation = {
	provides: Vault,
	requires: { persistence: Persistence },
	create({ dependencies }) {
		return createVaultBackend(dependencies.persistence)
	},
}
```

`dependencies.persistence` 必须从 token 推导，不能依赖调用方断言。这里只注入该准备阶段允许访问的能力，
不把 Plugin/Part 的 owner-view 注入共享 root backend；owner-aware 服务仍在各 owner view 创建时绑定 Context。
一个产品安装项可以提供多个必要 descriptor，例如 Vault owner API 与宿主内部管理能力；它们展开为一份计划统一查重，
不要求用户为每个内部 backend 安装一次服务。上面的单 provides 示例不表示每个安装项只能承载一个 descriptor。
installation 用一次性准备计划连接异步 backend，用现有 kernel installation 描述同步属性/view；
不把异步生命周期塞进同步 Context kernel，也不复制其缓存和 identity 实现。

服务安装器显式声明必需的宿主 capability token，例如 Vault 需要 Persistence。
Host 在创建资源前检查缺失与循环，再按 provider-first 准备、反序关闭。依赖成立只表示能力已提供，
不表示 backend 已准备好；IO/preflight 失败在准备阶段清理并拒绝启动。
此处与 Plugin 的 require 不同：宿主服务的准备依赖已知且由安装器声明，Plugin 的完整业务路径需求不做自动推导。

多态优先放在已有领域 backend 接口上：保持同一个 Persistence token 和 namespace API，
由 persistence 安装配置选择文件、内存或自定义 backend。Vault 无需知道具体驱动，
也不要求外部创建第二个同名 Persistence 服务。多种 backend 是择一配置，不是在同一属性上安装多个 provider。

当前 Vault backing 实际读取 `ctx.root.persistence.namespace('vault')`；Persistence 已有 custom backend、memory、readonly 接口。
当前 PersistenceService 无配置时使用隐式 memory，而标准 Runtime application 默认补入文件目录；
不能将 launcher 的默认行为写成服务本身必然采用文件系统。新组合让底层 backend 选择显式，官方组合明确选文件默认。

backend 的兼容性包括原子写入、namespace 隔离、durable/readonly、错误与关闭语义，不只看 TypeScript 方法形状。
需要持久化/可写保证的服务应在准备时核验需求；不能把远端存储实现的弱语义当成本地文件原子写入。
backend 的创建、借用与关闭责任必须明确；创建资源仍应发生在 Host 管理的阶段，不在声明求值时打开连接。

### 服务专属页面由普通管理 Plugin 提供

统一采用“静态服务＋普通管理 Plugin”。服务只提供领域能力；管理 Plugin 通过 `ctx.require(Token)` 获取服务，
通过已有 Workbench publication 发布页面与明确的交互 API。不在服务安装器中携带页面注册 callback，
不增加服务 publication owner、隐式伴随 Plugin 或服务管理贡献 registry。

```text
Persistence ──提供存储──> Vault
VaultAdminPlugin ──require──> Vault
VaultAdminPlugin ──可选 publish──> Workbench
```

Vault 不依赖 Workbench，Workbench 不依赖 Vault。真正互相必需的宿主服务拒绝循环，
不通过延迟 lookup 掩盖；跨服务 UI 集成放进消费这些服务的普通 Plugin。

管理 Plugin 与其他 Plugin 共用 catalog、启停、generation、effects、RPC lease 与 artifact/HMR 路径。
Workbench 未安装时跳过可选发布，不创建运行期 renderer/compiler；服务仍可被其他插件使用。
构建是否携带相应 UI 是发行 variant 的独立决定，不能从运行时 optional callback 未执行推导产物零字节。
管理 Plugin 停止或替换只撤回自己发布的页面、API 和注册，不关闭服务；服务由 Host 唯一拥有。
应用显式选择管理 Plugin，服务安装器不修改 Plugin catalog。官方 application/starter 同时列出服务和相应管理 Plugin，
让默认体验完整，但组合结果必须可见，不能建立自动扫描和隐式安装规则。

管理 Plugin 仍是正常 Plugin package 的 root named export，不借服务包的任意子入口承载 Plugin。
领域算法留在服务，管理 Plugin 只做页面、DTO、校验和授权接线，不复制 Vault 加解密或 Persistence 实现。
取到服务 token 不等于获得管理员身份；敏感交互必须保留现有 principal 授权及 owner admission。
root-only 管理权限不因页面迁移而新增通用 Plugin 访问入口。官方 Vault 管理页沿用宿主拥有的具名管理 RPC，
从同一认证会话的浏览器客户端调用；Vault 管理 Plugin 负责发布 UI，不为转发既有 RPC 再取得 root 管理 handle。
这同时保留 headless 管理：停止页面 Plugin 不停止 Vault，也不撤销宿主已提供的管理 RPC。
外部 Search 管理 Plugin 对普通 owner API 的交互可使用自己的 Workbench root；涉及宿主特权的操作仍由宿主显式绑定，
不把“已经发布页面”作为授权。页面专属交互随 Plugin 撤回，宿主管理 RPC 随其原有宿主/认证会话边界撤回。
不为每种服务生成管理 RPC；只有实际需要 headless/特权操作的服务增加显式接入，同一用例只保留一份实现。

这里保护的是公开 API 的权限与远端 principal，不声称 Context 是同进程恶意 Plugin 的安全沙箱。
类型可见性、backing scope、owner attribution 与管理授权是四件事，不能仅隐藏 root 属性就宣称完成隔离。

## 6. 生命周期、身份与效率

复用当前 Context kernel：root backend 共享资源，scope 保存 generation 状态，owner-view 固定调用者。
Part 与 caller view 保持现有隔离和缓存规则，注册进入原有 effects，不另建全局“当前 Context”。
使用普通属性与预编译 descriptor，不为每次服务调用增加 Proxy 或通用调度器。
安装关系只在创建时验证；token 解析和可选属性读取共用既有 capability 缓存，业务方法继续调用具体服务。

HTTP、Workbench 等需要参与 finalize、settle、prepare 与 publish 的服务，接入当前固定生命周期阶段。
Host 负责统一顺序、失败传播和已准备资源的同步发布；服务不在任意 callback 内独立提交 graph 或发布半成品。
多服务组合的准确阶段顺序须用真实 HTTP 与 Workbench 接线验证，不预先开放万能 hook 总线。

作者契约、descriptor 与安装实现保持同一 canonical identity。Core 继续内联 Context kernel；
不能混用 standalone `@pluxel/context` 创建的 installation，也不能只重导出 internal helper 冒充稳定宿主入口。
服务包需要通过 Core 的受控组合入口创建相同 kernel 的能力。Vite、生产 facade 与安装后的声明产物共同验证身份。
不通过包名后缀猜测 Runtime/服务，也不向业务应用开放任意覆盖 singleton classifier 的策略。
服务 token 模块属于稳定身份边界；其重新求值不能让当前 Host 的插件取得另一枚同名 token。
服务契约/安装实现的开发更新应进入宿主替换路径或明确要求重启，不当作普通 Plugin HMR；
具体可跟踪范围与 native module 限制由共享开发驱动明确报告。

## 7. 通用管理面与持久化

Host 持有通用管理 facade，管理端点和 console 借用同一份 use case：catalog/status、生命周期、auto-start、fork、
依赖选择、配置读写及订阅。catalog 可用、希望运行、实际运行继续分开；安装结果不替代这些事实。
catalog、配置、状态各有自己的 revision，不引入伪跨存储全局事务。

mutation 进入现有 exclusive queue，读操作返回已确认 immutable snapshot。请求收到或排队不等于取得执行权；
执行 admission 核对所属会话/epoch，领域校验与 revision 检查在相应协调边界完成。
已进入不可撤销阶段的操作必须 settle；关闭连接不意味着回滚。慢订阅首帧提供当前状态，随后有界合并最新快照。

会话 lease、owner lease 与排队操作的持有范围必须明确。尤其管理操作停止认证 provider 自身时，
不能让 provider drain 与该操作持有的 lease 相互等待；这是抽取前需要验证的接线边界。
稳定领域拒绝保留 code/discriminant，编程异常继续 reject，transport envelope 不吞并 apply report。

Core 继续独占 raw record、revision、validation cache、normalized snapshot 和 generation notification。
存储适配器只负责读取、确认写入与关闭，Host 编排沿用：

`validate once → stage → flush/存储确认 → 确认 revision → notify 当前 generation`

失败写入不发布未确认配置；通知失败保留保存结果并报告 `saved-not-applied`，未运行报告 `deferred`。
默认内存确认不承诺跨进程持久化。配置存储与 Host state 不合并成万能 KV，不承诺跨二者 ACID；
既有复合操作的补偿、readonly、冲突、初始化、seed 与关闭语义必须保留。
表单 presenter 可选，无 presenter 仍能读取、校验和修改配置；服务端 schema 函数不发送给浏览器执行。

## 8. 管理接入、HTTP 与 Workbench

管理端点借用 Host，不监听端口。提供普通 Request 的 fetch 处理、carrier 完成 upgrade 后的 WebSocket 接入及 close。
未命中管理前缀返回明确的未处理结果，例如 `Response | null`，不通过 404 内容猜测是否命中。
保留 Cap’n Web over WebSocket；不另造一套 REST 管理操作，不用非标准 Response 假装可移植 upgrade。
carrier 不支持 WebSocket 时，在挂载完整管理端点时明确拒绝。

认证前不授予管理 capability。peer/TLS/可信 origin 来自 carrier，缺失为 unknown；
不相信客户端 Host/Forwarded header，不自动给外部 carrier 开放 loopback recovery。
保留 cookie commit、单次 ticket、origin 校验、provider withdrawal 与 generation drain 契约。
官方认证插件复用官方 Vault 等实际依赖，不能因为 management 可组合就省略认证接线。

浏览器每个 document 使用一条物理管理连接，Workbench 与扩展共用认证和会话。
扩展为启动时固定、具名、类型/版本明确的 capability root，自行负责校验、授权、lease 与撤销；
不开放 Context 枚举、任意 Plugin 方法 RPC 或 `invoke(string, unknown)`。

HTTP 的三种职责分开：物理 listener 属于 carrier，管理端点借用 carrier，Plugin HTTP application 是独立可安装服务。
使用 management 不应强制安装官方业务 HTTP 框架；组合官方 HTTP 时仍保留 generation application、owner lease 与发布语义。

Workbench 纳入本提案的共享能力，包含发布与交互、必要 artifact 接入和可直接复用的官方 UI。
外部 Host 不需要重写工作台；自建配置页面可使用同一管理客户端/RPC。
UI 只呈现实际可用的能力，不因“官方 Runtime”身份假定 Vault 或数据库存在。
Workbench 的宿主组合必须显式满足管理接入与 carrier 需求；官方默认组合负责列齐，
不让 `workbench()` 悄然安装另一份管理服务或监听器。内部必要 descriptor 可以由同一个安装项提供，仍统一查重。

`workbench-app` 最终负责 shell、会话、导航、通用插件管理与已有插件页面承载。
服务专属页面由对应管理 Plugin 提供，外部 Search 等服务沿同一路径扩展，不要求 shell 枚举所有服务。
当前预编译的 Vault/Security 页面是迁移输入：保留宿主管理访问与审计等通用部分，将 Vault 专属内容整理为管理 Plugin，
复用现有组件与领域操作。实施时切换路由与查询归属，不能永久保留两套 Vault 管理页面或 RPC 业务实现。
优先使用现有 Plugin 页面导航；不为保留某个固定菜单位置预先增加 shell 扩展协议。
迁移可以分步交付，但当前提案只保留这一条最终页面扩展路径。

工作台物理会话认证不自动授权每项服务管理操作。隐藏页面只是展示行为，服务端仍需检查权限。
共享预编译 shell 可能含未使用的公共 UI 代码，不据此声称所有未安装服务的前端字节都为零；
运行资源、实际加载和发行闭包分别验证，不新增按服务集合生成整套工作台的构建系统。

独立应用用自己的前端框架消费管理 RPC，不要求 Workbench 更换 renderer。
将其他框架的插件页面嵌入官方 Workbench 是另一个 renderer/bridge 契约；本轮保留当前技术契约，不承诺任意框架互换。
服务类型增强也不会自动让工具链识别新的作者入口；Workbench/Node declarations 的 lowering 必须随入口迁移验证。

## 9. Artifact 与 HMR

服务安装集合变化或应用服务启动配置变化创建新 Host epoch。普通 Plugin 源码更新在当前 Host 内更新 graph，
保持运行意图，不默认重建 root。配置 mutation 沿配置 revision/notification 路径执行，不以页面 reload 冒充应用成功。

复用 Workbench/Node artifact 是当前组合目标的一部分，但两个领域不能被抽象成相同的回滚事务：

| 边界                        | 接受与失败语义                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------ |
| graph 关联 artifact 候选    | 准备不改变 active 资源；graph 接受点同步激活预验证资源；拒绝则丢弃候选               |
| Workbench producer 后台构建 | 结果验证后再次核对 publication epoch；迟到结果不发布；沿既有会话撤销和整页刷新策略   |
| Node consumer setup         | 每 consumer 串行 staged setup；新 setup 成功才清理旧 setup，失败保留 last-known-good |
| owner stop                  | 撤销新接纳，使 pending 工作失效；迟到 setup 的资源立即清理                           |

compiler 不重新发现已有 semantic declarations，不建立第二份 build revision 或通用构建队列。
关闭后不能创建 backend/compiler/watcher。未选中 Workbench 的组合不加载其 UI builder。
artifact 接入参与更新接受阶段，开发附件只负责借用已准备的 Host；两者不共用含糊的 attach 回调权限。

Plugin replacement 在第一次关闭旧 generation admission 前可保留旧状态，此后 drain/init 失败形成新 revision 的事实，
不复活旧 implementation。整个 Host replacement 是另一条路径：官方现有 single-active logging 要求先关闭旧 Host；
候选创建/启动抛错后清理候选，再从上一成功声明创建 fresh 补偿 Host。补偿成功才报告 restored，失败则明确无可用 Host。
补偿 Host 取得新 epoch，不恢复旧连接/handle。正常返回的局部 Plugin lifecycle issues 不触发整宿主补偿。

纯管理订阅可跨同一 Host 的 Plugin HMR 存活，generation/publication-bound 扩展按其撤销契约失效。
客户端报告 epoch invalidation，不在旧 document 静默转接新 Host；官方 Workbench 保留整页刷新，外部 shell 自行选择提示或刷新。
生产原生 ESM 已加载入口升级仍要求进程重启，不用 query cache bust 声称实现传递依赖 HMR。

## 10. 开发会话、console 与生产接入

每个 Vite server 只有一个共享 ModuleRunner 与更新队列。应用仍是普通对象加 `satisfies`，固定 plugins 与可选 sources
共用候选路径，不添加 static/dynamic mode。用户只安装一个平台开发插件，平台内部组合服务和开发接入。

开发附件在内部借用准备好的 Host，按声明顺序绑定，逆序清理；全部成功后才发布会话并开放 discovery/请求接纳。
失败清理已绑定附件和候选 Host。关闭与异步绑定交错时，迟到返回的 cleanup 必须执行，不允许再发布；
附件回调不在 coordinator 锁内等待。

console 提取现有 Unix discovery、源码 admission、执行队列、取消、预算及结果协议。CLI 不依赖 Runtime、不求值 Plugin。
通用 scope 操作 Host 管理 facade，HTTP、commands、Workbench、日志等按实际安装能力接入；不继承 test host。
每个 run 借用固定 epoch，先等待已观察文件更新和有限 barrier，脚本体不长期占据 coordinator。
replacement 先 abort 旧 run、撤回附件/连接、drain 跟踪操作，再关闭旧 Host。未协作脚本不能强制终止，
未 settle 不虚假释放执行 slot，取消不回滚已提交操作。沿用当前全部预算，不把执行服务暴露到公共管理 HTTP。

开发和生产消费同一 application/service 声明。生产启动必须调用公开组合路径，明确存储、carrier、artifact 与关闭责任。
初期沿当前 Node target；实际 freezer/production adapter 扩展签名待代表性切片验证，不能仅验证打包 identity 就宣布可部署。
Node target 与监听器承载是两件事：保留当前可嵌入的 fetch launcher，让 Electron 等宿主调用生成模块的 fetch/stop，
不要求它创建网络 listener，也不据此宣称支持 Worker 平台。正常服务端 launcher 仍负责 listener 和信号关闭。
安装器模块导入与 application 声明求值不得启动资源，启动配置仍在每次启动解析。
动态 package manager 仍是文件生产者，安装、发布、catalog 接纳和 running 保持不同事实。

### Static build 是组合路径的完成条件

保留当前 application freezer 的领域实现，将其配置接线迁移为 tsdown-aware Pluxel 插件；
标准用法使用 tsdown 官方 `defineConfig()`，不另造 services 专用构建器，也不长期保留两套并行配置入口。
插件继续消费声明性应用 entry，复用同一 semantic lowering、Plugin artifact pipeline、Node bootstrap、residual tracing 与 final assembly。
移除 Runtime 包不等于移除其承担的 production adapter、framework identity facade 或 Workbench assets；
这些职责必须迁移到明确的新 owner 后才可删除旧路径。

canonical application 保持静态可分析的固定 Plugin catalog 与现有环境绑定语法，服务安装配置在每次启动解析。
freezer 不通过执行 application、服务工厂或连接真实存储来发现插件/资源。默认组合不得把固定管理 Plugin 隐藏在
任意 factory 执行结果中；需验证与当前 direct application export/AST 规则兼容的组合表达，再固定公开签名。
程序式 `createHost()` 示例说明生命周期，不表示顶层 `await createHost()` 可直接作为 freezer 输入。

| 产物                     | 来源与保持的边界                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Server chunks            | Core、Host、选中服务/后端与固定 Plugin 闭包；可 code-split，不残留要求部署端安装的 Pluxel framework imports |
| Workbench shell          | `workbench-app` 的预构建浏览器资源，独立于 server chunk                                                     |
| Plugin UI producer       | 普通业务 Plugin 和服务管理 Plugin 的既有 Workbench declarations，沿现有 producer 构建/验证路径              |
| Content                  | Markdown 等静态内容转换后的 immutable plan 与所需资源                                                       |
| Node artifacts           | 无论是否包含 Workbench，继续收集可达的 Node module/worker artifacts                                         |
| 应用静态文件             | 业务 SPA 的 `public/`，与 Workbench shell/producer/Content inventory 分开                                   |
| Native/residual packages | 继续由现有 tracing 与显式 residual 配置形成可搬运部署闭包                                                   |

Workbench shell 仍输出到 `workbench/public/`，producer 与 Content 继续使用现有 revision/content-addressed 布局和 inventory。
业务 `public/` 不覆盖这些资源；服务管理 Plugin 的页面属于 Plugin producer，不复制进 shell 或建立服务专用 artifact 类别。
现有固定 URL namespace、deployment root 定位及 immutable distribution 外存放持久化数据的规则保持。

Workbench 发行入口必须交付预构建 shell assets；不能要求独立消费工作区存在 monorepo 的 `workbench-app` 源码。
该发行入口由 Workbench 包或服务发行部分明确拥有，freezer/开发接入通过稳定资源解析接口定位，不继续依赖 Runtime 私有路径。
shell、管理 Plugin producers 与 browser-safe client 的共享模块/version identity 一并迁移验证；
浏览器代码不能因服务单入口设计导入安装器、Node backend 或 Plugin server implementation。

构建 variant 与运行安装清单仍是两个不同边界：

- `workbench` 产物携带 shell 和所需 UI/Content artifacts，但不强制每次启动安装 Workbench。
- `headless` 产物不携带 Workbench browser closure，也不得通过默认组合间接加载其 backend/compiler；
  运行声明若要求安装 Workbench，必须在资源启动前拒绝，不能静默缺失页面。
- variant 是发行能力选择，不是恢复 `{ workbench: false }` 等运行期减法配置。
  不执行启动配置来猜测唯一构建 variant；声明/安装计划与发行能力能静态判定的冲突尽早报错，其余在启动前校验。

单服务入口中的字面量动态 import 仍可能被 bundler 收集为 chunk；只有运行期不执行不足以证明产物不含数据库。
选中的 backend 闭包必须可追踪，沿现有显式 driver 选择/residual 机制收敛发行内容，
不对不可分析动态加载退回部署端临时安装。未选择服务或驱动的成本用实际 artifact inventory 验证。

### 未选服务不进入部署闭包

已有下游证据：Rhythm 的运行声明使用 `database: false`，static build 同时配置 `managedDatabaseDrivers: []`，
分别约束资源安装与驱动发行。当前 freezer 将未选 managed driver 的内部入口替换为明确报错的模块，
避免 PGlite/pg 进入 residual tracing。这是现有全量 Runtime 闭包的显式裁剪，不能仅用 lazy import 或 external 代替。
该观察来自下游当前配置与 freezer 源码，不代表本轮重新构建验证了其发行物。

新组合的目标是以正向引用形成闭包，减少这种运行/构建两份关闭清单：

| 应用实际选择                                      | 部署结果                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| 未选择 Database，且没有其他真实代码路径需要其实现 | 不携带 Database backend、驱动、native/wasm 或其专属静态文件                  |
| Plugin 只 import Database token，宿主未安装       | 可保留轻量契约与缺失诊断；token 不应拉入安装器/backend 的执行闭包            |
| 显式安装 Database，只选择一个 backend             | 保留服务及该 backend 的必要闭包，不因全量 driver loader 顺带携带其他 backend |
| 明确支持启动时在多个 backend 中选择               | 携带所有允许的候选；不能把启动时条件误判为构建期死代码                       |
| 服务已安装但暂时没有 Plugin 读取                  | 仍保留服务；不能用“未观察到 require”删除显式安装或宿主自身使用的能力         |

服务入口内部保持 token 模块与安装实现分离，并如实标记副作用；只导入 token 时，未引用的安装器与其依赖应能被消除。
不能全包虚报 `sideEffects: false` 来掩盖真实注册/初始化，也不能假设一个总 barrel 的条件分支一定会被消除。
默认组合根入口不成为所有服务 token 的转发入口；未使用默认组合时不得带入它的服务闭包。

backend 配置优先接收明确选中的工厂/适配器，使 import graph 能区分实现；
避免一个服务安装器固定动态 import 全部 backend 再按运行时字符串选择。
确需多 backend 的发行能力才保留显式构建选择，并在启动选择超出发行能力时明确失败；
不把 `managedDatabaseDrivers` 推广为每个服务都要填一份的全局排除 registry。

external 只表示不内联，不表示不发行：真正必需的 native/non-bundleable 依赖仍应被追踪到部署目录。
反之，不可达的官方服务不能仅因为属于已安装 npm 包或默认 residual 名单就被全量复制。
native/wasm、模板、目录资源与代码一样，需要从实际选中闭包或明确 residual 声明取得复制依据。
若单入口经真实 bundler 验证无法隔离 token 与重型实现，再针对该服务调整入口/包，优先保住产物契约。

对应验收检查 bundle 模块来源、动态 chunks、residual node_modules 和静态资源 inventory，
同时启动搬离 workspace 的产物验证选中服务仍工作；只看主文件大小、配置值或 tree-shaking 开关不足以证明裁剪成立。

全部 server、Workbench、Content、public、Node artifacts 和 residual files 完成后，继续由同一 distribution finalizer
生成 deployment/distribution inventory；后续复制静态文件仍需重新 finalization。
保留现有完整性/签名边界，不因移动包入口改动发行协议。

验收必须包括：独立安装工作区构建后搬离 workspace，以新 Node 进程启动，真实浏览器打开 shell、官方/外部管理插件页面、
静态 Content 和业务 SPA，并调用管理操作；另验证 headless、不安装数据库及缺失 artifact 的明确失败。
既有 static build 目前仍按当前 Runtime 接线运行；上述迁移验证完成前，不宣称新的 Services 组合已兼容 freezer。

### 官方配置与普通插件列表

下面为目标 API 示意，具体插件名尚未发布。外部 Reports 能力拥有自己的 `reports.define()` 声明、编译器和运行服务，
并非 Workbench 的 UI 消费插件；其工具链通过相同工厂接入两种环境。

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown'
import { pluxel } from '@pluxel/rolldown'
import { reports } from '@acme/reports/tooling'

export default defineConfig({
	entry: './src/app.ts',
	outDir: './dist',
	sourcemap: true,
	plugins: [pluxel({ variant: 'workbench' }), reports()],
})
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { pluxel } from '@pluxel/host-dev/vite'
import { reports } from '@acme/reports/tooling'

export default defineConfig({
	plugins: [pluxel({ entry: './src/app.ts' }), reports()],
})
```

`entry`、`outDir`、minify、sourcemap 等通用生产选项由 tsdown 配置表达，不复制进 Pluxel options；
Pluxel 只拥有 variant、部署闭包等领域选项。目标 Node/ESM 等硬约束补默认值，显式冲突时报错，不静默覆盖用户选择。
记录用户 application entry 后接入虚拟 bootstrap；统一处理路径、配置解析和实际输出目录，不要求用户手写生成 entry。

当前安装的 tsdown 0.22.14 已提供 `tsdownConfig` 与 `tsdownConfigResolved`，无需以“无法修改配置”为由保留配置工厂。
在前者接线和补默认，在后者读取/验证最终配置；不能修改 resolved config。
其配置合并会替换数组，追加插件时必须保留用户列表；在该 hook 中追加的新插件不会再收到 `tsdownConfig`。
因此需要配置 hook 的外部插件直接出现在初始列表，不依赖 Pluxel 递归注入来触发它们。
实际升级支持范围需以发布所需的 tsdown 版本固定并验证，不能仅依赖本工作区安装版本。

### 外部声明能力保持原生插件形态

`reports()` 返回普通 Rolldown-compatible 插件，可使用正常的 `resolveId`、`load`、`transform` 和输出 hooks，
必要时附加 Vite/tsdown 生命周期。共享的是工厂、语义分析、领域编译器与配置，不是跨 build/server/environment 的可变实例。
普通转换插件无须实现额外协议；只有需要共享源码分析或纳入 artifact/HMR 的能力才使用公共工具。

```ts
// 外部能力的基本形态；analyze/lower 是外部自己的普通函数。
export function reports(): Plugin {
	return {
		name: 'acme:reports',
		transform: {
			filter: { id: /\.[cm]?[jt]sx?$/ },
			handler(code, id) {
				// 按需调用共享 parse helper，再做本能力的分析。
				return lowerReports(code, id)
			},
		},
	}
}
```

不强制改为 `ToolingFactory`、`defineToolchain()` 或框架 callback，不为普通插件设计接纳握手与能力注册流程。
共享 AST 是普通 helper；需要 artifact 交付或运行资源更新时才借用窄的协作接口，
其绑定方式通过真实 Vite/tsdown 插件验证，不先固定全局 registry、协议协商或自动发现机制。
用户只维护标准 `plugins` 列表，不再维护一份 `tooling` 或独立 artifact 插件清单。
外部工具链从独立 build-time 入口导入，不进入服务运行入口或浏览器依赖图。

运行服务和工具链是两个不同选择：有些服务完全不需要编译，有些工具链能构建尚未运行的插件包。
不扫描 application imports 自动加载包内工具链，也不把 Node/Vite 编译器带进服务安装计划。
使用需要 lowering 的声明却未配置对应工具链时，应在编译期能识别处或原始声明被执行时明确失败，
不能返回看似可用的资源；仅凭 Host 安装清单无法保证构建期发现所有遗漏。
平台可封装相同插件工厂清单减少配置漂移，但不执行服务工厂来取得这份清单。

共享分析工具以 environment、语言/解析选项、模块身份与精确源码快照为边界缓存只读 AST，缓存有界。
各插件可以自行遍历、使用自己的编译库并返回正常 code/map；源码改变后重新分析新快照。
只承诺相同快照复用解析，不承诺整条第三方插件链只 parse/遍历一次；不强制 visitor DSL，也不直接修改共享 AST。
声明识别依赖真实 import binding/provenance，不按 `defineXXX` 函数名猜测。
跨模块事实、删除与失效由事实所属能力维护，不借 AST cache 保存过期的运行状态。

### 产物协作按实际需要接入

不要求每个扩展先登记 kind/version 和编译函数。按真实输出需要使用既有机制：

| 外部能力需要什么             | 最小接入                                     | 为什么需要                                          |
| ---------------------------- | -------------------------------------------- | --------------------------------------------------- |
| 只转换代码或提供虚拟模块     | 原生 transform/resolveId/load                | 正常 bundler module graph 已拥有它                  |
| 向当前 bundle 输出普通资源   | 原生 emitFile/addWatchFile 等                | bundler 已拥有输出和 watch 生命周期，无需再登记一份 |
| 子构建或目录产物进入完整发行 | 向 assembly 交付文件、定位信息和真实完成结果 | finalizer 必须知道何时可以收集完整文件集            |
| 资源更新影响当前 Host        | 将版本化候选和依赖接入现有更新接受边界       | 不能让失败或迟到结果污染正在运行的资源              |

表中不是互斥模式配置，也不为每行新增工厂；一个普通插件按需要调用相应 helper。
持久化或跨进程消费的产物描述需要明确格式与兼容规则，纯内部任务则不强制公开 kind/version 协议。
产物标识和路径由拥有该领域的编译器及统一 assembly 协调，不新增取代所有现有 identity 的全局 artifact registry。
同一输出不能既由 emitFile 又由目录复制路径重复拥有；路径冲突明确失败。

外部能力拥有声明解释、领域编译、诊断与结果校验，框架拥有组装与 Host 接受的时机。
使用资源引用的生产端与运行消费端必须共享最小定位契约，不能将构建工作区绝对路径写进发行物。
子构建须能报告依赖和完成结果；Vite/watch 修改、模块删除、声明清空与失败重试不能遗留上一候选事实。
共享模块图已有的依赖不重复登记；模块图不知道的模板/资源通过原生 watch 或窄的 Host 失效接点接入。
版本归属、过期结果拒绝和关闭排空复用当前机制，不强制公开所有内部任务状态。
Abort 不代表编译已经停止，不新增 ModuleRunner 或覆盖各领域已有并发预算的全局编译队列。

生产与开发复用同一编译实现，消费结果的生命周期明确不同。Vite serve 不运行 production writeBundle；
普通模块更新走 Vite，关联 Plugin/宿主资源的候选沿既有 Host 接受边界发布。
不能用“插件工厂相同”推导自动支持 HMR，也不能把所有资源改动都变成 Host replacement。
Workbench publication、Node staged setup、Reports 下次 open 读取新模板各自保留消费语义，
不预设统一 commit/rollback API。

最终发行需要一个明确完成阶段：等待 server 输出、子构建、静态复制与 residual tracing，再 assembly/finalization。
实现先核对 tsdown 生命周期是否提供足够的完成点，不凭 hooks 的数组顺序、未 await 的 Promise 或任意延迟判断完成。
只有原生完成点无法覆盖实际子构建时才添加窄的完成登记，不将其推广成公共工作流引擎。
用户在完成阶段之后写 dist 必须重新 finalization，延续当前发行规则。

先让官方 Workbench、Node artifact 与一个外部 `defineXXX()` 能力走同一公共接入，
验证插件包构建、static application 和真实 Vite 更新后再固定协议。
内置能力不能继续使用外部拿不到的关键事实或发布权限，以免公共 API 只是一层无法独立工作的包装。

### Rhythm 场景推演：用真实应用约束组合设计

以下依据下游源码和配置进行假设迁移，未修改或启动 Rhythm，亦未验证新架构的运行结果。
下游仍使用其当前版本的 `defineStaticRuntime/staticApplication`，不能将其旧入口视为本仓当前 API 权威。

观察到的事实：

- Server 使用官方 HTTP、Vault、Workbench 与多平台音乐 Plugin，同时用自己的 libSQL/SQLite 数据库；
  `prepareRhythmDatabase()` 在 Plugin 启动前准备数据库，以 root WeakMap 保存绑定并登记 root effects 关闭。
- Server 同时配置 `database: false` 与 `managedDatabaseDrivers: []`，业务前端另行构建后复制到 public，再执行发行 finalization。
- Desktop 复用音乐 provider Plugin，使用 fetch launcher 与自己的 Elysia bridge，不安装 Workbench；
  Electron 导入生成的 app 模块并检查 fetch/stop，不要求物理 HTTP listener。
- 音乐 provider 已有可选 Workbench 页面，并通过 Vault 保存凭据；缺失 Vault 时在 init 中自行报错。
  固定 catalog 与 auto-start 列表不同，部分平台插件可用但默认不启动。
- Server 需要显式 native/residual 追踪，例如 streamer 与 voice；生产还分离业务 SPA/gateway 与后台管理访问边界。

对应的目标组合是能力清单，不是新的可执行配置语法；确切服务依赖仍需逐项审计：

| 能力/责任                   | Rhythm Server                          | Rhythm Desktop                                               |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| RhythmDatabase              | 自定义服务，宿主启动时指定 SQLite 路径 | 同一服务，使用 userData 下自己的路径                         |
| Persistence / Vault         | 官方持久化与凭据服务                   | 复用相同音乐插件时显式满足其凭据需求；不因 headless 自动省略 |
| Plugin HTTP                 | 提供业务 API                           | 提供进程内 fetch bridge                                      |
| Carrier                     | Node listener，配合现有 gateway        | Electron 借用 fetch/stop，无 listener                        |
| Management / Workbench      | 按现有管理需求安装，业务前端独立       | 不默认安装；业务 bridge 不依赖管理面                         |
| Plugin catalog / auto-start | 保留固定可用集合与启动策略的区别       | 独立的桌面集合，复用适合的音乐 provider                      |

最直接的收益是将现有数据库准备、root 绑定与资源释放接入公开安装计划；
`rhythmDatabaseFor(ctx)` 可迁移为 `ctx.require(RhythmDatabaseToken)`，保留迁移、写入串行化和 close 等领域实现。
只创建一个 backend 不代表必须采用 kernel 的 root-only 可见性：若 Plugin 需要访问共享业务 API，
可用 owner-view 投影共享 backend，访问模式与 backing 生命周期分别设计。
该数据库不是官方 Database 的替代实现，不强迫它实现官方 token、迁移协议或无用的 owner schema 语义。

自定义服务逻辑没有变化时，普通 Plugin HMR 复用 root 数据库；服务配置变化则走 Host replacement，先 drain 再关闭。
构建时不会执行数据库 migration 或依赖本地已有数据库。关闭官方 Database 的两处配置应因未引用其安装实现而消失，
但 native streamer、外部资源追踪等实际依赖声明保留，不能把“服务可组合”解释成自动发现任意原生加载路径。

不要把 Rhythm 的每个业务 Plugin 都转换为服务，也不强制把已有音乐 provider 的可选页面拆成伴随管理 Plugin。
普通业务 Plugin 已拥有正确的 graph 和 generation，继续保留其 UI；伴随管理 Plugin 解决的是常驻服务缺少发布 owner 的问题。
产品 SPA、Electron renderer 和 gateway 配置继续由应用拥有，不强制变成 Workbench 页面或进入 Host 服务生命周期。

运行时选择与发行选择继续区分：用户可以在一次启动前决定是否安装 Workbench，同一 workbench distribution 可以支持该选择，
但运行期间不改 shape。正向计划允许条件构造，并不要求取消应用已有部署开关；
去掉的是框架默认全安装后再逐项关闭的模型，不是所有 boolean 应用配置。

需要关注的证据缺口：当前 Desktop application 源码未显式配置 Vault，复用的 QQ 等 provider 则明确要求 Vault；
这只说明需要核对完整启动默认值和运行报告，不能据此断言 Desktop 当前故障或已经满足需求。
当前 Desktop 构建也未像 Server 一样显式排除 managed drivers，不据配置猜测最终体积，迁移验收检查真实 inventory。

验收增加 Server/嵌入式 Desktop 两种消费边界：复用相同插件、保持数据库数据与关闭顺序、业务 HTTP 不依赖 Workbench，
完整构建后可搬运，音乐 UI/Content 正常，未选择服务及桌面/服务端独有 native 闭包互不串入。
不同 pnpm/Vite peer 图下不得迫使应用长期保留任意 unknown 类型断言才能组合框架插件；
发行类型与原生 hooks 兼容性也应在独立安装样例中验证，不新增无行为 adapter helper 作为永久解法。

## 11. 迁移与验收顺序

1. 先做类型/安装切片：两 Host、一个官方服务、一个外部服务，验证 ambient 可选性、token 身份、作用域、冲突和失败清理。
   同时确定可被 freezer 消费的默认组合/application 表达，不先承诺另一个启动工厂。
2. 将同一小样例接入普通 tsdown/Vite 插件及一个外部声明编译器，完成最小静态产物和一次真实更新。
   提前验证 AST 复用、产物交付、完成阶段及单服务入口闭包，不能在全量服务迁移后才发现构建契约不成立。
3. 提取服务及 Host 通用管理操作、存储、端点和客户端；官方组合改走相同路径。
   保留领域实现，迁移官方插件到 Core 加真实服务依赖，验证配置报告、认证与原单 socket 契约。
4. 接入官方 Vault/外部 Search 管理 Plugin、Workbench/Node artifacts 与 console，迁移服务专属页面。
   验证页面独立启停、headless RPC 保留、授权、失败候选、Host replacement 与迟到清理。
5. 完成独立 tarball 安装、搬离 workspace 的生产/browser 验证及官方/create 回归，确认无数据库/headless 闭包。
   迁移完旧 Runtime 的 toolchain/dev/web/test 和生产映射后才移除旧入口；旧插件不会自动取得跨组合兼容性。
6. 将已实现事实写入 `docs/` 和当前工程约束，按公开包实际变化补 Tegami；删除被替代实现、过渡转发和已实现提案段落。

各步扩展同一条代表性路径，不能等最后才让外部消费者使用。复用现有领域测试，不为每个 facade 重复测试 graph。

| 证据               | 必须证明的结果                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 类型与发布声明     | 两 Host 的必选类型不同；token 返回类型及 Part/root 作用域正确；外部包无 ambient 偶然依赖                                  |
| 服务与生命周期     | 重复/同名安装在创建前拒绝；缺失、身份问题与构造错误区分；Plugin/Part/caller 缓存不串线；失败清理完整                      |
| 管理真实连接       | 认证、unknown peer、排队撤销、provider 自停、订阅撤回、端点关闭不关闭 Host                                                |
| Workbench/artifact | 官方/外部管理 Plugin 共用发布路径；停管理插件不停止服务；授权无放宽；失败候选不污染 active 资源                           |
| Vite/console       | 同实例操作、有限 barrier、epoch replacement、附件失败和迟到清理                                                           |
| 工具链扩展         | 普通转换不需要额外协议；tsdown/Vite 原生接入；共享快照只读；子构建结束后组装；失败、删除与重复构建不残留                  |
| 外部发行与生产     | Core/service identity 唯一；无 Runtime 必需依赖；服务单入口无意外重依赖加载；无数据库组合不引入其执行闭包；真实启动和关闭 |

本提案是设计交付，以上是未来实施验收，不表示本轮已经实现或运行这些验证。

## 12. 已选路径与实施前验证

最终路径为：Core 加服务包作者契约、token 返回值读取、正向静态安装、显式服务依赖、backend 多态、
普通管理 Plugin 与共享 Workbench、单服务入口及 Services 根入口的默认 Host，以及 tsdown/Vite 原生插件式工具链。
第三方属性使用有组织/领域辨识度的名字；同名仍按双层检查拒绝，不提供任意别名。
管理面展示已安装能力和实际启动失败，不声称提前发现所有 Plugin 服务需求。
Services 提供默认服务组合，官方 application/starter 显式选择配套管理 Plugin；
外部可从空的附加服务清单开始，不靠关闭开关减去官方默认服务。

以下是会改变公开签名或接线选择的证据缺口，不应以继续增加抽象来掩盖；通过最小切片回答后再迁移：

- **类型与作用域**：确定目录投影和 token 类型如何表达 Plugin/Part/root 可用范围，检查 generic 拓宽与声明发行。
  backing scope 和访问权限不是同一个概念，不能用一个 scope 枚举代替全部访问规则。
- **身份与更新**：验证两份服务包、错误 kernel、Vite 重新求值和生产 facade 的行为；保持 object identity，
  不为修复重复安装而引入字符串去重或自动版本兼容。
- **构造与清理**：验证 Plugin/Part 的字段初始化、require 的严格惰性和构造失败 cleanup，再决定缓存字段的正式支持范围。
- **生命周期与闭包**：用 HTTP/Workbench 验证固定阶段组合；梳理 Vault/persistence、认证和 Node artifact 的实际依赖，
  防止各自取得提交权威或隐式带回全量 Runtime。
- **管理 Plugin**：验证 Vault 页面通过同一管理客户端访问现有宿主管理 RPC，Search 页面通过自己的 owner API 工作；
  停止页面不关闭服务或已有 headless RPC，授权保持，且没有新增 root 权限投影。
- **生产与包边界**：验证声明性默认组合与 freezer AST 规则、shell assets 发行归属、Node adapter 接线、单服务 token 导入/声明闭包及默认组合的实际服务清单，
  再确定重依赖拆包、exports 和调用签名；原生 ESM 与 bundler 分别验证，不以 tree-shaking 替代导入无资源副作用。
- **工具链公共接入**：验证原生 hooks 与完成点能覆盖多少工作；只为剩余的子构建交付和 Host 更新接点固定公共 helper。
  Workbench、Node 与外部能力共同验证，不预设参与者 registry、握手协议、全局 kind/version 或工具链工厂 DSL。

完成判据不是“所有服务都已经拆包”，而是一个独立消费者仅用公开入口能完成：
组合服务 → 使用官方与自定义 Plugin → 发布管理页面 → Vite 更新 → tsdown 完整打包 → 搬离 workspace 后运行。
这条链上没有重复声明清单、私有接线或隐藏的第二实现，才说明抽象成立。

不纳入本轮：运行期安装/卸载服务、任意第三方实现替换协议、自动服务发现、第二套 Plugin 依赖图、
静态推导所有服务使用、服务页面发布者体系、通用 UI 框架 adapter、重做包管理器或生产 ESM HMR。
设计以复用插件和工作台、保持类型诚实、减少无关运行成本为准，不以新增接口或包数量衡量。
