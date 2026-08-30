# `@pluxel/package-manager`

Pluxel 官方、可选的 pnpm package source producer。它使用 `@pnpm/napi` 管理一个隔离 pnpm project，把每个受管 package
原子发布为普通 `.mjs` entry。`@pluxel/runtime-dynamic` 只观察这些文件并执行正常 graph/HMR lifecycle。

## Host 装配

```ts
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
	runtimeState: { snapshot: { autoStart: [pluginNodeAddressOf(PackageManagerPlugin)] } },
	workbench: { enabled: true },
})
```

`plugins` 把管理插件加入固定 catalog，RuntimeState 的 `autoStart` 声明其冷启动策略；`sources` 是唯一的 runtime 接缝。source directory 必须和
插件的 `rootDir/entries` 一致。插件会在加载 pnpm native engine、创建目录、注册 commands 或发布 Direct View 前验证这项声明；static host
会以 `DYNAMIC_SOURCE_REQUIRED` 启动失败，声明不匹配则以 `DYNAMIC_SOURCE_NOT_DECLARED` 失败。
Workbench enabled 时，插件发布固定的 `PackageManagerWorkbench.manager` Direct View，placement 是 plugin-relative `/packages`。
每次打开都会创建 fresh `PackageManagerApi` target；零 props renderer 通过
`useWorkbench(PackageManagerWorkbench.manager)` 取得该 root。Workbench 根据 catalog node address 生成导航，调用方不拼接 Plugin
名称 URL。headless host 仍可使用 `package.install` 和 `package.remove` commands。

安装、自动启动策略和当前进程启停是三个独立操作。安装成功只发布 source；dynamic runtime 按 RuntimeState、session intent 和正常 dependency graph 决定插件是否
启动。删除 package 会先让 pnpm prune managed project，再删除 entry，之后由 dynamic batch 卸载对应 module。

## 安全默认值

```ts
host.cfg(PackageManagerPlugin).set({
	rootDir: '.pluxel/managed-plugins',
	ignoreScripts: true,
	allowBuilds: [],
	minimumReleaseAgeMinutes: 1_440,
})
```

- 只接受小写 npm registry package name 加 version/range/dist-tag，不接受 alias、path、URL、Git 或任意 tarball；
- 默认忽略 dependency scripts；需要 native build 时同时设置 `ignoreScripts: false` 并显式列入非空 `allowBuilds`；
- 默认拒绝发布未满一天的版本；
- registry/auth/proxy 来自 pnpm config，但不会进入 RPC、snapshot 或日志；
- mutation 串行化，一批 specs 只调用一次 native install。

本仓库固定 `@pnpm/napi@12.0.0-rc.0`。npm 的 `latest` tag 当前仍指向占位版本，`next-12` 才是可用的新引擎；包内
adapter 隔离该预发布 API。升级时先验证 full-manifest `install()`、specifier parser、config/auth shape 和各平台 native
binding，再调整 adapter。

默认测试会加载 native binding 并验证 adapter shape；维护者可运行
`PLUXEL_PNPM_NATIVE_INTEGRATION=1 pnpm --filter @pluxel/package-manager test`，额外执行真实 registry install → entry publish →
remove 闭环。

受管数据位于 `.pluxel/managed-plugins/`：`package.json` 与 lockfile 是 pnpm project，`node_modules` 是 materialized
graph，`entries/*.mjs` 是 dynamic runtime 的公开文件协议。不要让其他工具直接改写 entries；需要另一种 package/market
策略时实现另一个 source producer。

工程不变量见 [`DESIGN.md`](DESIGN.md)，宿主用户路径见
[`../../docs/plugins/package-manager.md`](../../docs/plugins/package-manager.md)。
