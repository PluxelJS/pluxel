---
title: 插件市场与包管理器
description: 可选连接插件市场，或直接通过 pnpm 准备和安装插件包。
---

> `@pluxel/plugin-package-manager` 目前只供 Pluxel 工作区使用，尚不是公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

需要在受控应用中安装 npm 插件时使用本页；它目前是仓库内部预览。已有应用的固定依赖直接写进应用清单，Git 源码协作使用 [源码开发](../development/tooling.md)，部署格式见 [发行物](../development/distribution.md)。

包管理器下载 npm 包并发布 `.mjs` 入口。Native 在下次新进程启动时发现；Vite 在当前进程观察更新。安装只增加可用插件，是否启动仍由应用的运行策略决定。

市场浏览与直接安装都属于同一个 `PackageManagerPlugin`。默认没有市场连接，仍可直接输入 npm package spec 安装；配置市场后增加搜索和发行选择，不改变原生 pnpm 的 registry、认证或构建策略。

## 装配宿主

```ts no-twoslash
import { zenfs } from '@pluxel/core/config'
import { resolve } from 'node:path'
import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'
import { Passthrough } from '@pluxel/core/fs'
import { resolveHostEnv } from '@pluxel/host/environment'
import { PackageManagerPlugin } from '@pluxel/plugin-package-manager'
import { pluginSource } from '@pluxel/host/sources'

const packageManagerNode = PackageManagerPlugin.nodeAddress()

export default defineHostApplication(async (startup) => {
	const dataRoot = resolve(
		startup.deployment?.root ?? startup.root,
		resolveHostEnv(startup.env).dataRoot,
	)
	const managedPackagesRoot = resolve(dataRoot, 'managed-plugins')
	const prefix = resolve(dataRoot, 'fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'managed-plugins',
		plugins: [PackageManagerPlugin],
		sources: [
			pluginSource({
				kind: 'directory',
				path: resolve(managedPackagesRoot, 'entries'),
				include: ['*.mjs'],
			}),
		],
		services: await servicesPreset(startup, {}),
		policy: { autoStart: [packageManagerNode] },
		config: {
			records: [
				{
					owner: packageManagerNode,
					config: {
						rootDir: managedPackagesRoot,
						ignoreScripts: true,
						allowBuilds: [],
						minimumReleaseAgeMinutes: 1_440,
					},
				},
			],
		},
		runtime: {
			zenfs: zenfs({
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			}),
		},
	}
})
```

四处配置缺一不可：

1. `plugins` 把 Package Manager 放进 fixed catalog；
2. `config.records` 为它提供 Plugin config；
3. `policy.autoStart` 显式让它随宿主自动启动；
4. `sources` 声明它被允许生产的 directory source。

示例通过 `PLUXEL_DATA_ROOT` 统一定位存储和来源；默认是 cwd 下的 `.pluxel`。生产运行时设置 distribution root 外的绝对路径。

source path 必须与 `rootDir/entries` 一致。Plugin 会在加载 native engine、创建目录、注册 command 或发布 Direct View 之前验证该声明；未声明动态来源的宿主会以 `SOURCE_REQUIRED` 失败，dynamic source 不匹配会以 `SOURCE_NOT_DECLARED` 失败。

## 配置安全默认值

根入口导出的 `PackageManagerConfig` 可直接用于应用 `envBindings`，不依赖 Workbench：

```ts no-twoslash
import { envBinding } from '@pluxel/host'
import { PackageManagerPlugin, PackageManagerConfig } from '@pluxel/plugin-package-manager'

envBinding(PackageManagerPlugin, {
	config: {
		schema: PackageManagerConfig,
		mapping: {
			minimumReleaseAgeMinutes: 'PLUGIN_MINIMUM_RELEASE_AGE',
			ignoreScripts: 'PLUGIN_IGNORE_SCRIPTS',
		},
	},
})
```

若绑定 `rootDir`，应用的 `sources` 必须使用同一个最终路径。来源优先级由 [Host 输入绑定](../host/configuration.md#绑定部署环境与-json-文件) 维护。
保存的安装清单、revision 和 pnpm lock 是安装状态，不覆盖 Plugin config；pnpm registry/auth/proxy 仍使用 pnpm 自身配置。
无 Workbench 时，通过 required dependency 的 `snapshot()`、`install()`、`remove()` 或已注册 Commands 完成相同业务操作，安装回执不等于插件已运行。

上例的 Plugin config 同时展示了安全默认值。运行中的配置更新由宿主 ConfigService 负责，不通过测试 fixture API 修改
production host。

| 字段                       | 默认值                    | 含义                                               |
| -------------------------- | ------------------------- | -------------------------------------------------- |
| `rootDir`                  | `.pluxel/managed-plugins` | host-owned 隔离 pnpm project；相对当前工作目录解析 |
| `ignoreScripts`            | `true`                    | 默认禁止 dependency scripts                        |
| `allowBuilds`              | `[]`                      | 允许执行 build script 的精确 package names         |
| `minimumReleaseAgeMinutes` | `1440`                    | 拒绝发布时间不足一天的版本                         |
| `markets`                  | `[]`                      | 可选的市场连接 `{ id, url }`                       |

只有同时设置 `ignoreScripts: false` 与非空、精确的 `allowBuilds` 时才允许 native/build scripts。Registry、auth 和 proxy 读取 pnpm config；认证、代理和原始配置不会进入 snapshot、RPC payload 或日志。市场返回的发行来源 URL 是独立的公开坐标。

## 可选市场

在该 Plugin 的 config 中加入连接即可；`url` 是服务的 base URL，不包含 `/v1`：

```json
{
	"markets": [{ "id": "community", "url": "https://plugins.example.com" }]
}
```

每个连接有唯一 ID；可使用 HTTP(S)，但 URL 不接受凭据、query 或 fragment。地址由部署配置提供，页面只提交连接 ID。
连接在 Plugin 启动时读取，修改后重新启动 Package Manager 以采用新连接。
未配置时页面只提供直接安装和已安装包管理。连接失败显示该市场的错误，直接安装仍可使用。

同一市场可列出多个部署方配置的 registry。包身份为 `registry + name`，同名的公共 npm 和私有 PNPR 包保持独立；列表、已收录版本和安装准备始终保留所选来源。`marketPackages(marketId, query)` 支持文本、`registry`、`official`、`category`、`tag` 筛选，文本最长 100 字符，每页 1–50 条。`official`、分类和标签由市场管理员维护，不根据包名前缀、作者 keywords 或构建 provenance 推断。

Workbench 的 `/market` 直接打开市场；`/packages` 保留已安装包、直接安装和市场页。两个入口复用同一个 Store 和安装 API，每次打开各有独立的 renderer 资源所有者。市场用紧凑卡片展示来源、官方标记、分类和标签；次要筛选默认折叠，点击分类或标签也可筛选。筛选变化从第一页开始，窄容器使用单列卡片，打开包详情后收起搜索区域。

`marketPackage(marketId, name, registry)` 读取包概览，`marketReleases(marketId, name, { registry })` 从所选来源读取已校验版本，`marketRelease(marketId, name, version, registry)` 读取精确发行。三者省略 registry 时选择公共 npm。`prepareMarketInstall` 必须带上列表返回的 registry，例如 `{ marketId, registry: pkg.registry, name: pkg.name, version }`；`version` 应来自该来源的已收录版本列表。

包概览可在 `indexedVersions: 0` 时提供介绍、许可和 registry 提供的包级 README；这只表示元数据已观察，不表示已有可安装发行。页面明确区分概览 README 与经过校验的发行制品 README，后者还可查看 peer/plugin dependencies 和 integrity。README 支持标题、段落、列表、代码块、引用、链接和 GFM 表格；HTML 只显示为文本，图片显示替代文字，不请求远程图片。只有 HTTP(S) 或邮件绝对链接可跳转，相对链接和其他协议保留文字。公共 npm 包可打开对应版本的 npmx 页面；私有来源不生成公共链接。

市场安装由后端重新读取所选发行，再使用原生 pnpm 下载并核对来源、版本与 SHA-512 integrity；不会执行市场返回的 tarball URL。pnpm 的包 scope registry 必须与发行声明一致，不会为了安装覆盖本机 registry/auth 配置。请求来源不匹配或私有包读取失败时，返回明确失败，不改装公共 npm 的同名包。客户端当前匿名读取市场目录，需要认证的私有来源由市场管理 API 操作，不把管理密钥加入市场 URL 或普通插件配置。
市场摘要的 `latest` 保留 npm 实际 tag 指向，尚未收录的版本会明确读取失败，不改成已收录的最高版本。页面另列已收录发行，用户可明确选择旧版；版本页的顺序不表示 semver 新旧。
卡片与概览的 Repository 是包声明的规范 HTTPS 仓库链接，不等于构建来源已验证。仓库 stars 只显示市场实际观测到的数量，并保留观测时间；未知数量不显示为 0。只有精确发行的已验证 provenance 才展示 Source verified、提交和构建链接。
自建服务的启动、管理与当前 provenance 限制见 [Worker 项目](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md)。

### 独立挂载市场界面

`@pluxel/plugin-package-manager/marketplace` 导出纯 React `Marketplace`、市场 DTO 和 `PackageMarketClient`。这个入口不依赖 Mantine、Workbench Provider 或 CapnWeb，样式随组件携带，所有规则限定在 `.plx-marketplace` 内；`colorScheme` 可设为 `light` 或 `dark`，默认 `light`。

宿主提供一个稳定的 `MarketplaceData`，包含 `Packages`、`Package`、`Releases`、`Release` 四个读取组件。它们分别接收 `query`、`identity`、`identity + query`、精确发行 `identity`，并通过 `children(read)` 渲染 `{ data?, error?, isFetching, refetch }`。`data` 保留 `MarketReadResult<T>` 成功或失败事实。读取组件负责缓存、取消和丢弃晚到结果；市场界面只维护搜索、分页和所选包。组件类型应在模块中创建，切换市场时用 React `key` 隔离界面状态。

下面的组件接收宿主已绑定到一个市场的读取组件，不提供安装能力：

```tsx
import { Marketplace, type MarketplaceData } from '@pluxel/plugin-package-manager/marketplace'

export function Catalog({ data }: { data: MarketplaceData }) {
	return <Marketplace data={data} />
}
```

独立 HTTP 适配实例见 [市场网页数据适配器](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/web/market-data.ts)。复用 `PackageMarketClient` 时，创建时可传 `AbortSignal`，读取所有权结束时调用 `close()`。Workbench 适配器继续使用当前打开项的 query resources 和现有 RPC，不新建 HTTP transport。

只有宿主显式传入 `onPrepare({ registry, name, version })` 时，经过市场校验的精确发行才显示安装预览按钮。回调不执行安装，宿主仍应使用自己的 `prepareMarketInstall`、预览和 `confirmInstall`；官网浏览不传此回调。

## 准备后确认安装

Workbench 的直接输入与市场选择共用两步流程：

1. **准备**：pnpm 解析版本并下载依赖，在私有 revision 中生成候选；当前公开入口保持不变。预览显示最终精确版本、摘要和发生变化的受管包。
2. **确认**：校验预览仍有效、安装选择没有变化、准备文件字节未变，然后发布同一批文件。确认不再次解析 tag、下载或执行构建脚本。

准备会使用磁盘和网络；部署方放开构建脚本时，准备阶段就会执行获准脚本。预览有效期 10 分钟，同一 Plugin 同时只保留一个候选；重新准备、其他安装/卸载提交或 Plugin 停止后，旧预览需重新生成。关闭页面不等于卸载已发布文件。

通过注入的 `PackageManagerPlugin` 也可执行相同流程：

```ts no-twoslash
const prepared = await packages.prepareInstall(['@acme/example-plugin@^2.0.0'])
if (!prepared.ok) {
	console.error(prepared.failed)
} else {
	console.log(prepared.plan.packages) // 交给本应用的确认界面
	// 用户确认后，使用同一 plan.id；不能重新 prepare 代替确认。
	const installed = await packages.confirmInstall(prepared.plan.id)
	if (!installed.ok) console.error(installed.failed)
}
```

预览包含完整受管包选择；升级一个共享依赖可能使其他包也发生变化。首版尚未逐一列出 Host 内受影响的 Plugin/fork，确认前应评估这些包的所有消费者。
确认后的选择固定为预览中的精确版本。Native 显示下次新进程启动发现，Vite 显示交由当前来源观察；两者都不声称 Plugin 已启动。
准备流程要求 registry 提供 SHA-512 integrity；仅有旧 SHA-1 摘要的包仍可通过原有 `install()` 使用 pnpm 原生安装，但不支持该预览流程。

## Commands 与 Workbench Direct View

Plugin running 后发布 `package.prepare`、`package.confirm`、`package.install` 与 `package.remove`。交互式安装使用 prepare/confirm；已经明确授权安装的程序调用可以使用原有一步 install：

```ts no-twoslash
import { Commands } from '@pluxel/services/commands'

const installed = await ctx.require(Commands).execute('package.install', {
	specs: ['@acme/example-plugin@^2.0.0'],
})
if (installed.isErr()) throw new Error(installed.error.message)
console.log(installed.value)

const removed = await ctx.require(Commands).execute('package.remove', {
	specs: ['@acme/example-plugin'],
})
if (removed.isErr()) throw new Error(removed.error.message)
console.log(removed.value)
```

- `package.prepare({ specs })` 返回准备回执，`package.confirm({ planId })` 发布所选候选；
- `package.install` 直接安装插件包，`package.remove` 删除插件包；
- 每次接受 1–100 个 spec，成功执行返回 `Result.ok({ ok, succeeded, failed })`；
- 部分成功和每个包的失败仍是提交回执；输入、安装、卸载、失效预览与市场读取分别使用 `INVALID_SPEC`、`INSTALL_FAILED`、`REMOVE_FAILED`、`INVALID_PLAN`、`MARKET_FAILED`；
- 输入校验或命令执行故障返回 `Result.err(CommandFailure)`。

初始化严格核对发布记录、不可变安装字节和既存 entry；缺失、损坏或旧布局明确失败，需离线修复/转换，不在运行时自动改写合同。有效 entry 不因重启而重发。

每次安装先建立独立 revision，使用 pnpm global virtual store 的共享 immutable slots；完整 lockfile resolution/peer/optional 图与实际字节共同决定变化。图、字节和物理路径不变的包保留 wrapper 正文、inode/mtime 和 inner entry；未知图会拒绝发布。旧 revision/slots 保留至离线维护，升级、卸载和 Plugin close 不删除旧代的延迟 import、资源或制品。

Host 不应继承用于构建调度的 `PNPM_CONFIG_WORKSPACE_DIR`（以及 pnpm/npm 的大小写变体）。pnpm 原生引擎会让首个非空环境值覆盖显式安装目录；两者不一致时，Package Manager 在读取原生配置或安装前明确拒绝，并指出来源变量与目标目录。清除该调度环境后重启 Host；运行时不会临时修改进程环境或将安装重定向到另一个工作区。

原生当前 Host 不观察发布，下一新进程扫描生效；Vite 观察实际图更新。安装回执只证明文件发布，不代表 catalog 接纳或 Plugin 激活成功。

Workbench enabled 时，Plugin 发布固定的 `PackageManagerWorkbench.manager` Direct View，placement 是 plugin-relative `/packages`。
每次打开都会创建 fresh `PackageManagerApi` target；零 props renderer 通过 descriptor-bound scope 声明 snapshot query 与
prepare/confirm/remove mutation 与市场 query，Framework 自动 detach 返回 DTO、释放 transport ownership，并刷新写入后的 snapshot。
完整类型从 `@pluxel/plugin-package-manager/workbench` 的 `PackageManagerApi` 获取；页面与无界面的 Plugin 方法消费同一 store。

这些调用与 layout、Management 共用当前 Workbench 的 Cap’n Web over WebSocket Runtime Session，不经过 command registry 或业务 HTTP。
Snapshot 在同一串行队列中读取已结算状态，包含 revision、engine、managed root、entries directory、packages、pendingRemovals 和检测到的 build-script dependencies。pendingRemovals 从实际残留入口推导，表示已离开安装选择但尚未完成撤回的包，不表示 Plugin 运行状态；Workbench 保留这些包的重试撤回操作。Workbench 路由由
catalog node address 生成，消费者不应拼接 Plugin class name URL。关闭 Workbench 的宿主 仍可使用 commands；Workbench disabled 时不会
创建相关 UI backend。

安装后在 `succeeded` 中确认文件发布。Vite 可进一步检查宿主 catalog；原生需在新的启动进程检查。再从正常插件管理入口启动它，确认运行状态；仅看到安装成功不表示插件已在运行。失败时读取 `failed` 中的稳定错误分类。

## 安装和运行策略不是同一动作

```text
package.install
  -> 校验 registry spec 与 policy
  -> pnpm 在私有 revision 物化依赖图
  -> 校验稳定的共享 slot 与完整图/字节
  -> 原子保存 published-installation.json
  -> 按条目原子发布 entries/*.mjs
  -> Vite 事务接纳 / native 新进程扫描
```

安装不会替新 Plugin 打开 auto-start 或 session start intent。删除只撤回公开 wrapper，不删除已使用的文件；Vite 随后按正常 lifecycle 撤回定义，原生当前 Host 保持运行。

受管目录结构：

```text
.pluxel/managed-plugins/
  published-installation.json  # 当前安装/选择的唯一 authority
  revisions/<id>/             # manifest、lockfile、依赖链接与 immutable inner entries
  slots/                      # pnpm 共享的 immutable dependency slots
  entries/*.mjs               # 稳定路径的公开 wrapper
  .writer/                    # 单写者 ownership，关闭后释放
```

初始化、mutation 和 snapshot 在进程内串行，关闭立即拒绝新操作并等待已开始的初始化或安装结算；重复关闭等待同一次 writer 释放。目录同时只能有一个进程写入；冲突返回 PACKAGE_STORE_WRITER_CONFLICT，遗留 writer 只能离线确认并清理。不要由其他工具改写 entries、revision 或 slots。其他 producer 也通过普通 file/directory 数据合同接入，不直接调用运行图 internals。

## 输入边界与失败语义

只接受小写 canonical npm registry package name 加 version、range 或 dist-tag。alias、filesystem path、URL、Git 和任意 tarball 都会被拒绝。单项失败通过结构化 mutation result 返回，错误消息会隐藏 registry credential。

如果 native install 失败，旧发布记录和 entries 保持可用。wrapper 是逐项原子发布，整批不是原子事务；部分发布时 succeeded/failed 如实标出条目，受影响的其他 managed 条目也可能出现在 failed，空 input 表示批次级发布故障。已完成的 wrapper 保持发布，snapshot 的 entryFile 仅在它与当前记录一致时存在；修复 IO 后在当前会话重试原操作。卸载失败即使已从安装选择移除，仍通过 pendingRemovals 展示残留入口，并可再次 remove；仅重试撤回不会重新安装依赖。调用时捕获输入数组，后续修改数组不改变排队目标。重启遇到发布记录与入口不一致仍明确失败，须离线修复。不发布半个文件，也不宣称已完成的条目已回滚。Plugin stop 会撤销 commands 和 Direct View publication，并使已打开的 API root 失效；managed project 是 host-owned
持久状态，不因一次 generation cleanup 被删除。

## 适用范围

适合：受控 Native/Vite 应用、内部插件试装、验证目录来源发布流程。

不适合：不保留目录来源的 standalone 发行物、把任意 npm package 当可信 Plugin、由 Plugin 自己执行 pnpm、或对外承诺稳定 package-manager SDK。离线交付请看 [发行物](../development/distribution.md)。
