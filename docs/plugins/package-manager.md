---
title: 动态宿主的包管理器
description: 在开发环境中为动态宿主管理和发布 pnpm 插件包。
---

# 动态宿主的包管理器

> `@pluxel/package-manager` 目前只供 Pluxel 工作区使用，尚不是公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

动态运行时本身不负责下载包。Package Manager Plugin 是一项可选的来源提供者：它通过 `@pnpm/napi` 管理隔离的 pnpm 项目，并把每个受管包以普通 `.mjs` 入口原子发布。动态运行时只观察这些入口，后续仍走正常的依赖图事务和 Plugin 生命周期。

## 装配宿主

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { PackageManagerPlugin } from '@pluxel/package-manager'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	plugins: [PackageManagerPlugin],
	sources: [
		{
			kind: 'directory',
			path: '.pluxel/managed-plugins/entries',
			include: ['*.mjs'],
		},
	],
	runtimeState: {
		snapshot: { enabled: [pluginNodeAddressOf(PackageManagerPlugin)] },
	},
	workbench: { enabled: true, access: { exposure: 'private' } },
})
```

三处配置缺一不可：

1. `plugins` 把 Package Manager 放进 fixed catalog；
2. `runtimeState` 显式启用它；
3. `sources` 声明它被允许生产的 directory source。

source path 必须与 `rootDir/entries` 一致。Plugin 会在加载 native engine、创建目录、注册 command 或挂载 UI 之前验证该声明；static host 会以 `DYNAMIC_SOURCE_REQUIRED` 失败，dynamic source 不匹配会以 `DYNAMIC_SOURCE_NOT_DECLARED` 失败。

## 配置安全默认值

```ts no-twoslash
host.cfg(PackageManagerPlugin).set({
	rootDir: '.pluxel/managed-plugins',
	ignoreScripts: true,
	allowBuilds: [],
	minimumReleaseAgeMinutes: 1_440,
})
```

| 字段                       | 默认值                    | 含义                                               |
| -------------------------- | ------------------------- | -------------------------------------------------- |
| `rootDir`                  | `.pluxel/managed-plugins` | host-owned 隔离 pnpm project；相对当前工作目录解析 |
| `ignoreScripts`            | `true`                    | 默认禁止 dependency scripts                        |
| `allowBuilds`              | `[]`                      | 允许执行 build script 的精确 package names         |
| `minimumReleaseAgeMinutes` | `1440`                    | 拒绝发布时间不足一天的版本                         |

只有同时设置 `ignoreScripts: false` 与非空、精确的 `allowBuilds` 时才允许 native/build scripts。Registry、auth 和 proxy 读取 pnpm config，但不会进入 snapshot、RPC payload 或日志。

## Commands、RPC 与 Workbench

Plugin running 后发布两个 runtime command：

```ts no-twoslash
await ctx.root.commands.executeOrThrow('package.install', {
	specs: ['@acme/example-plugin@^2.0.0'],
})

await ctx.root.commands.executeOrThrow('package.remove', {
	specs: ['@acme/example-plugin'],
})
```

- `package.install` 是 open-world、non-destructive、idempotent mutation；
- `package.remove` 是 open-world、destructive、non-idempotent mutation；
- 每次接受 1–100 个 spec，返回 `{ ok, succeeded, failed }`；
- failure code 是 `INVALID_SPEC`、`INSTALL_FAILED` 或 `REMOVE_FAILED`。

Workbench enabled 时，Plugin 挂载 plugin-relative `/packages` 页面，并通过 typed RPC 暴露：

```ts no-twoslash
interface PackageManagerCommands {
	snapshot(): Promise<PackageManagerSnapshot>
	install(specs: readonly string[]): Promise<PackageMutationResult>
	remove(names: readonly string[]): Promise<PackageMutationResult>
}
```

Snapshot 包含 revision、engine、managed root、entries directory、packages 和检测到的 build-script dependencies。Workbench 路由由 catalog node address 生成，消费者不应拼接 Plugin class name URL。headless dynamic host 仍可使用 commands；Workbench disabled 时不会创建相关 UI backend。

## 安装和启用不是同一动作

```text
package.install
  -> 校验 registry spec 与 policy
  -> pnpm 一次性更新 managed dependency graph
  -> 确认每个 direct dependency 已 materialize
  -> 原子发布 entries/*.mjs
  -> dynamic source batch 观察变化
  -> 正常 catalog/RuntimeState/依赖图 commit
```

安装成功只表示 source 已发布，不会绕过 RuntimeState 自动启动新 Plugin。删除时先让 pnpm prune managed graph，再删除 entry；source batch 随后按正常 lifecycle 卸载 module。mutation 被串行化，一批 specs 只执行一次 native install。

受管目录结构是：

```text
.pluxel/managed-plugins/
  package.json       # managed project manifest
  pnpm-lock.yaml     # managed graph lockfile
  node_modules/      # materialized dependencies
  entries/*.mjs      # 唯一公开给 dynamic runtime 的文件协议
```

不要让其他工具直接改写 `entries/`，也不要让 dynamic route 调用 Package Manager 私有 store。要实现另一种 registry、market 或审批策略，应实现另一个 source producer，并继续通过普通 file source protocol 接入 runtime。

## 输入边界与失败语义

只接受小写 canonical npm registry package name 加 version、range 或 dist-tag。alias、filesystem path、URL、Git 和任意 tarball 都会被拒绝。单项失败通过结构化 mutation result 返回，错误消息会隐藏 registry credential。

如果 native install 失败，旧 manifest 和 entries 保持可用；如果安装成功但 entry publication 失败，操作返回可重试失败，不把半个 entry 暴露给 route。Plugin stop 会撤销 commands/RPC/UI，但 managed project 是 host-owned 持久状态，不因一次 generation cleanup 被删除。

## 适用范围

适合：受控开发 host、内部插件试装、验证 dynamic source producer 流程。

不适合：production static distribution、把任意 npm package 当可信 Plugin、由 Plugin 自己执行 pnpm、或对外承诺稳定 package-manager SDK。静态离线交付请看 [Static 发行物](../development/distribution.md)。
