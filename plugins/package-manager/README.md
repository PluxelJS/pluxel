# `@pluxel/package-manager`

Pluxel 官方、可选的 pnpm package source producer。它使用 `@pnpm/napi` 管理一个隔离 pnpm project，把每个受管 package
原子发布为普通 `.mjs` entry。`@pluxel/host/dynamic` 只观察这些文件并执行正常 graph/HMR lifecycle。

## Host 装配

```ts
import { pluginNodeAddressOf } from '@pluxel/core'
import { PackageManagerPlugin } from '@pluxel/package-manager'
import { dynamicSource } from '@pluxel/host/dynamic'
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'

const packageManagerNode = pluginNodeAddressOf(PackageManagerPlugin)
const packageManagerConfig = {
	rootDir: '.pluxel/managed-plugins',
	ignoreScripts: true,
	allowBuilds: [],
	minimumReleaseAgeMinutes: 1_440,
}

export default defineHostApplication(async (startup) => ({
	name: 'plugin-host',
	plugins: [PackageManagerPlugin],
	sources: [
		dynamicSource({
			kind: 'directory',
			path: '.pluxel/managed-plugins/entries',
			include: ['*.mjs'],
		}),
	],
	services: await servicesPreset(startup, { persistence: '.pluxel/persistence' }),
	configRecords: {
		mode: 'memory',
		initial: [{ owner: packageManagerNode, config: packageManagerConfig }],
	},
	state: { mode: 'memory', initial: { autoStart: [packageManagerNode] } },
}))
```

`plugins` 把管理插件加入固定 catalog，Host config records 提供 Plugin config，Host state 的 `autoStart` 声明其冷启动策略；`sources`
是唯一的 runtime 接缝。source directory 必须和插件的 `rootDir/entries` 一致。插件会在加载 pnpm native engine、创建目录、注册
commands 或发布 Direct View 前验证这项声明；没有声明来源的 host 会以 `DYNAMIC_SOURCE_REQUIRED` 启动失败，声明不匹配则以
`DYNAMIC_SOURCE_NOT_DECLARED` 失败。
Workbench enabled 时，插件发布固定的 `PackageManagerWorkbench.manager` Direct View，placement 是 plugin-relative `/packages`。
每次打开都会创建 fresh `PackageManagerApi` target；零 props renderer 通过 descriptor-bound `managerScope` 声明
snapshot query 与 install/remove mutation。Workbench 自动 detach DTO、释放 transport ownership，并在写入 settle 后失效 snapshot。
Workbench 根据 catalog node address 生成导航，调用方不拼接 Plugin 名称 URL。headless host 仍可使用 `package.install` 和
`package.remove` commands。

初始化保留有效的既存 entry；安装按锁定依赖图更新变化的 entry，删除包不会重新发布图未变的其他包。传递依赖、peer 和 optional 依赖变化仍触发对应来源更新；无法识别锁文件时保守重新发布。

安装成功、entry 发布、catalog 接受、插件运行是独立事实。生产 Host 使用原生 ESM 加载，升级已经加载的 entry 会报告 `PLUGIN_SOURCE_RESTART_REQUIRED`，需要重启进程；开发驱动才拥有完整模块图失效能力。

安装、自动启动策略和当前进程启停是三个独立操作。安装成功只发布 source；Host 按持久运行策略、session intent 和正常 dependency graph 决定插件是否
启动。删除 package 会先让 pnpm prune managed project，再删除 entry，之后由 dynamic batch 卸载对应 module。

## 安全默认值

上例的 `packageManagerConfig` 同时展示了安全默认值。运行中的配置更新由宿主 ConfigService 负责，不通过测试 fixture API 修改
production host。

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

Workbench 的 `PackageManagerApi` 使用 `snapshotDto()`、`installDto()` 和 `removeDto()` 返回纯数据；本地 Plugin 的 `snapshot()`、`install()` 和 `remove()` 保持领域命名。RPC target 在返回前校验数据，不复制 store 快照。
