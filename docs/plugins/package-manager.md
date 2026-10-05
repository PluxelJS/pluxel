---
title: 插件包管理器
description: 为 Native 与 Vite 应用管理和发布 pnpm 插件包。
---

> `@pluxel/package-manager` 目前只供 Pluxel 工作区使用，尚不是公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

需要在受控应用中安装 npm 插件时使用本页；它目前是仓库内部预览。已有应用的固定依赖直接写进应用清单，Git 源码协作使用 [源码开发](../development/tooling.md)，部署格式见 [发行物](../development/distribution.md)。

包管理器下载 npm 包并发布 `.mjs` 入口。Native 在下次新进程启动时发现；Vite 在当前进程观察更新。安装只增加可用插件，是否启动仍由应用的运行策略决定。

## 装配宿主

```ts no-twoslash
import { resolve } from 'node:path'
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'
import { resolveHostEnv } from '@pluxel/host/environment'
import { PackageManagerPlugin } from '@pluxel/package-manager'
import { pluginSource } from '@pluxel/host/sources'

const packageManagerNode = pluginNodeAddressOf(PackageManagerPlugin)

export default defineHostApplication(async (startup) => {
	const dataRoot = resolve(
		startup.deployment?.root ?? startup.root,
		resolveHostEnv(startup.env).dataRoot,
	)
	const managedPackagesRoot = resolve(dataRoot, 'managed-plugins')
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
		services: await servicesPreset(startup, {
			persistence: resolve(dataRoot, 'persistence'),
		}),
		configRecords: {
			initial: [
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
		state: { initial: { autoStart: [packageManagerNode] } },
	}
})
```

四处配置缺一不可：

1. `plugins` 把 Package Manager 放进 fixed catalog；
2. `configRecords` 为它提供 Plugin config；
3. `state` 显式让它随宿主自动启动；
4. `sources` 声明它被允许生产的 directory source。

示例通过 `PLUXEL_DATA_ROOT` 统一定位存储和来源；默认是 cwd 下的 `.pluxel`。生产运行时设置 distribution root 外的绝对路径。

source path 必须与 `rootDir/entries` 一致。Plugin 会在加载 native engine、创建目录、注册 command 或发布 Direct View 之前验证该声明；未声明动态来源的宿主会以 `SOURCE_REQUIRED` 失败，dynamic source 不匹配会以 `SOURCE_NOT_DECLARED` 失败。

## 配置安全默认值

上例的 Plugin config 同时展示了安全默认值。运行中的配置更新由宿主 ConfigService 负责，不通过测试 fixture API 修改
production host。

| 字段                       | 默认值                    | 含义                                               |
| -------------------------- | ------------------------- | -------------------------------------------------- |
| `rootDir`                  | `.pluxel/managed-plugins` | host-owned 隔离 pnpm project；相对当前工作目录解析 |
| `ignoreScripts`            | `true`                    | 默认禁止 dependency scripts                        |
| `allowBuilds`              | `[]`                      | 允许执行 build script 的精确 package names         |
| `minimumReleaseAgeMinutes` | `1440`                    | 拒绝发布时间不足一天的版本                         |

只有同时设置 `ignoreScripts: false` 与非空、精确的 `allowBuilds` 时才允许 native/build scripts。Registry、auth 和 proxy 读取 pnpm config，但不会进入 snapshot、RPC payload 或日志。

## Commands 与 Workbench Direct View

Plugin running 后发布两个 runtime command：

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

- `package.install` 安装插件包，`package.remove` 删除插件包；
- 每次接受 1–100 个 spec，成功执行返回 `Result.ok({ ok, succeeded, failed })`；
- 部分成功和每个包的失败仍是提交回执，failure code 是 `INVALID_SPEC`、`INSTALL_FAILED` 或 `REMOVE_FAILED`；
- 输入校验或命令执行故障返回 `Result.err(CommandFailure)`。

初始化严格核对发布记录、不可变安装字节和既存 entry；缺失、损坏或旧布局明确失败，需离线修复/转换，不在运行时自动改写合同。有效 entry 不因重启而重发。

每次安装先建立独立 revision，使用 pnpm global virtual store 的共享 immutable slots；完整 lockfile resolution/peer/optional 图与实际字节共同决定变化。图、字节和物理路径不变的包保留 wrapper 正文、inode/mtime 和 inner entry；未知图会拒绝发布。旧 revision/slots 保留至离线维护，升级、卸载和 Plugin close 不删除旧代的延迟 import、资源或制品。

原生当前 Host 不观察发布，下一新进程扫描生效；Vite 观察实际图更新。安装回执只证明文件发布，不代表 catalog 接纳或 Plugin 激活成功。

Workbench enabled 时，Plugin 发布固定的 `PackageManagerWorkbench.manager` Direct View，placement 是 plugin-relative `/packages`。
每次打开都会创建 fresh `PackageManagerApi` target；零 props renderer 通过 descriptor-bound scope 声明 snapshot query 与
install/remove mutation，Framework 自动 detach 返回 DTO、释放 transport ownership，并刷新写入后的 snapshot：

```ts no-twoslash
import type { RpcTarget } from 'capnweb'

interface PackageManagerApi extends RpcTarget {
	snapshotDto(): Promise<PackageManagerSnapshot>
	installDto(specs: readonly string[]): Promise<PackageMutationResult>
	removeDto(names: readonly string[]): Promise<PackageMutationResult>
}
```

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
