---
title: CLI 与工具链
description: 了解脚手架、插件构建、静态应用、HMR、源码联调和发行检查分别由谁负责。
---

`@pluxel/cli` 把脚手架、构建和诊断命令组织在一起；具体的 Vite、构建和运行时 API 仍由对应的包提供。CLI 是开发工具，不是应用运行时，因此业务代码不应从中导入运行时或构建辅助函数。

## 安装分层

```sh
# 一次性创建项目或插件
pnpm create @pluxel
```

项目内固定 CLI 版本：

```sh package-install
npx nypm add -D @pluxel/cli
```

个人机器上的随处可用入口；进入已固定 CLI 的项目后会委托本地版本：

```sh package-install
npx nypm add -g @pluxel/cli
```

`@pluxel/cli` 是统一 executable，但不是所有能力的安装闭包。项目 `package.json` 直接声明
`@pluxel/cli` 时，全局 `pluxel` 会优先使用这个项目本地版本；声明了但尚未安装时会失败并提示先安装，
不会悄悄回退到全局版本。CI 和 package scripts 应继续使用本地 `pluxel` 或 `pnpm exec pluxel`。

按命令安装可选能力：

Plugin/static build 与 Vite adapter：

```sh package-install
npx nypm add -D @pluxel/rolldown tsdown oxlint
```

Dynamic host：

```sh package-install
npx nypm add -D @pluxel/runtime-dynamic
```

`publish --webhook`：

```sh package-install
npx nypm add -D @pluxel/market
```

有 Workbench browser entry 的 host 还需要 Vite/React 等自己的 web toolchain。插件 package 的 canonical scripts 见 [开发和发布插件包](./plugin-package.md)。

这些 owner 只在执行对应命令时从当前项目解析和加载。`pluxel --help`、`pluxel --version` 和
`pluxel new` 不会加载 Rolldown、runtime-dynamic 或 market；缺少 owner 时只影响被调用的命令，并给出
安装提示。

## 当前 CLI 命令地图

| 目标                                | 命令                                          |
| ----------------------------------- | --------------------------------------------- |
| 生成 app/plugin workspace           | `pluxel new`                                  |
| 构建当前 Plugin package             | `pluxel build`                                |
| 生成/检查/rebase database migration | `pluxel database generate/check/rebase`       |
| 创建/检查/验证 static distribution  | `pluxel distribution create/inspect/verify`   |
| 写入/关联 delivery marker           | `pluxel distribution mark/correlate`          |
| 发布 npm package 并通知 market      | `pluxel publish`                              |
| Dynamic loader 诊断                 | `pluxel hmr prompt/doctor/enabled`            |
| 跨仓库 source checkout              | `pluxel source register/doctor/build/install` |
| 管理 source workspace               | `pluxel workspace`                            |

确切参数通过 `pluxel <command> --help` 查看。

## `pluxel build`

命令以当前 package root 为边界：

1. 读取 `package.json` 与 tsdown config；
2. 合并标准 Plugin build pipeline；
3. 运行 preprocessor、decorator/config semantic extraction；
4. 生成 server ESM 与 declarations；
5. 按 declaration 生成 Workbench、Node module、worker、database artifact；
6. 成功后事务性同步 generated package metadata。

用户 `tsdown.config.ts` 只描述 entry/output/minify/sourcemap 等普通 bundler 配置。不要再次安装第二套 semantic plugin。

```sh
pluxel build
pluxel build --watch
pluxel build --debug
```

package script 传参时：

```sh
pnpm build -- --watch
```

## `pluginPackage()` 与 CLI build

`pluginPackage()` 是 `@pluxel/rolldown/build` 的底层 library integration。CLI template 的 canonical 入口是 `pluxel build` + 普通 tsdown config；不要同时把两种模式叠加。

直接构建自定义工具时才调用 library API：

```ts twoslash
import { pluginPackage } from '@pluxel/rolldown/build'
```

普通 Plugin 作者不需要直接使用它。

## Static application build

Static application 使用不同输出拓扑：

```ts twoslash
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'workbench',
	target: 'node',
})
```

| Build              | 依赖策略                              | 输出目的             |
| ------------------ | ------------------------------------- | -------------------- |
| Plugin package     | 保留 runtime/provider peer boundary   | npm 发布与多宿主复用 |
| Static application | 冻结 fixed closure 与 Node deployment | 可部署完整目录       |

不要把 static application preset 用于独立 Plugin package，也不要把 target 机安装 package 当作 static closure 的一部分。

## Source build boundary

Static/dynamic Vite adapters 执行 Plugin semantic lowering、config extraction、artifact discovery 和 HMR wiring。Plugin source entry 必须通过这些 adapters 加载；Node 原生 type stripping 不生成 Pluxel metadata。Workbench browser graph 与 server Plugin implementation 保持分离。

## Node/worker artifact

`defineNodeModule()` 和 `defineWorkerTask()` 的 literal declaration 会生成 `dist/artifacts/node/` 下的独立 ESM。artifact 使用独立 graph validator，不能 value-import Plugin runtime/Context。

详细 clone/native/lifecycle 约束见 [Node module 与 worker task](../runtime/node-artifacts.md)。

## HMR diagnostics

Dynamic host 用户通过：

```sh
pluxel hmr doctor
pluxel hmr prompt
pluxel hmr enabled
```

workspace diagnostics 的 library subpath 是 `@pluxel/runtime-dynamic/hmr/diagnose`。它诊断 profile、source discovery 和 snapshot，不注册 dynamic runtime services。

## 验证顺序

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

遇到 build-time error 时先按作者边界判断：

- root export 是否唯一可追溯；
- constructor dependency 是否从 provider root value-import；
- `configs.use()` 是否是一个 object schema class field；
- optional ref/use 是否符合 direct-call shape；
- Workbench/worker/database declaration 是否使用 literal entry。

跨 checkout 联调见 [跨仓库源码开发](./source-workspaces.md)，发行物命令见 [Static 发行物](./distribution.md)。
