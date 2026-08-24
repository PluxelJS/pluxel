---
title: 开发和发布插件包
description: 创建一个可以独立构建、测试和发布的 Pluxel 插件包。
---

一个插件包应当让宿主只从包根入口导入 Plugin，同时保留完整的类型声明、运行时 peer dependency 和 Pluxel 构建元数据。这样依赖身份可以追溯到明确的包与导出，而不是某个源码路径或类名。

CLI 模板会生成标准目录结构：

```sh
pluxel new --template plugin --name @acme/orders
cd orders
pnpm verify
```

官方模板默认完成依赖安装；需要只生成文件时传入 `--no-install`。local template 则默认不执行安装，必须显式传入
`--install` 才会运行 package manager。编写 manifest 与 `.tpl` 文件前先阅读[自定义本地 Plugin 模板](./tooling.md#自定义本地-plugin-模板)。

## 标准目录

```text
src/
  OrdersPlugin.ts      Plugin implementation
  config.ts            server/shared-safe schema
  index.ts             如果模板使用独立 root barrel
  ui/                  可选 Workbench browser entry
tests/
  OrdersPlugin.test.ts
package.json
tsconfig.json
tsdown.config.ts
vitest.config.ts
oxlint.config.ts
```

一个 package root 是一个明确的 plugin-bearing entry。它可以导出 schema、types 和普通 helper，但具体 Plugin class 必须能从 `"."` 的 named export 唯一追溯。

## 包根入口决定 Plugin 身份

- consumer 从 package root value-import required Plugin。
- identity 来自 canonical entry + root named export，不是 class name、`displayName` 或 constructor object。
- 不从 `src/`、`dist/` 或未声明 subpath 导入 Plugin。
- 不跨 package re-export 别人的 Plugin class。
- Workbench contract、worker adapter 等 plugin-free 模块可以有独立 subpath，但不得形成第二个模糊 plugin-bearing root。

源码文件移动或 root export 重命名会得到新 definition identity。持久 config/runtime state 不按旧 class name 自动迁移。

## `package.json` canonical 形状

CLI 模板生成的关键部分如下：

```json
{
	"$schema": "https://market.pluxel.dev/schema/package.json",
	"name": "@acme/orders",
	"version": "0.1.0",
	"type": "module",
	"exports": {
		".": {
			"@pluxel/hmr": "./src/OrdersPlugin.ts",
			"default": "./dist/index.mjs"
		}
	},
	"files": ["dist", "!**/*.map"],
	"scripts": {
		"build": "pluxel build",
		"lint": "oxlint -c oxlint.config.ts src tests tsdown.config.ts vitest.config.ts",
		"format:check": "oxfmt -c .oxfmtrc.json --ignore-path .gitignore --check .",
		"test": "vitest run",
		"typecheck": "tsc --noEmit --pretty false",
		"verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
	},
	"peerDependencies": {
		"@pluxel/runtime": "catalog:"
	}
}
```

`@pluxel/hmr` 条件指向 source entry，default 条件指向构建 artifact。source condition 不作为生产部署入口。

Pluxel runtime 和 required provider packages 通常是 peer dependencies；构建、测试和 lint 工具在 devDependencies。具体版本策略由当前 workspace/catalog 决定。

## `tsconfig.json`

Plugin source 需要 decorator 和 source condition：

```json
{
	"compilerOptions": {
		"target": "ES2023",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"moduleDetection": "force",
		"strict": true,
		"noEmit": true,
		"verbatimModuleSyntax": true,
		"allowImportingTsExtensions": true,
		"isolatedModules": true,
		"customConditions": ["@pluxel/hmr"],
		"experimentalDecorators": true
	},
	"include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"]
}
```

不要用 TypeScript emit 代替 `pluxel build`。`tsc --noEmit` 只做类型检查，不生成 Plugin semantic facts、config schema、Workbench 或 Node artifacts。

## `tsdown.config.ts`

当前 CLI 模板使用普通 tsdown config：

```ts twoslash
import { defineConfig } from 'tsdown'

export default defineConfig({
	tsconfig: './tsconfig.json',
	entry: {
		index: 'src/OrdersPlugin.ts',
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})
```

构建命令仍然是 `pluxel build`。CLI 读取并合并这个 tsdown config，再安装标准 semantic/build pipeline；不要直接把 package script 改成裸 `tsdown`，也不要自行重复安装 decorator transform、config extractor 或 Workbench builder。

`pluginPackage()` 是 `@pluxel/rolldown/build` 的底层集成入口，适合自定义构建工具；canonical CLI package 使用 `pluxel build`。

## 依赖 metadata 如何生成

build 成功后，CLI 根据实际 semantic facts 同步 package metadata：

- required Plugin root imports；
- generated plugin package records；
- declaration/types 与 ESM artifact；
- config schema source；
- 可选 Workbench remote 与 Node/worker/database artifacts。

构建失败不会提交部分 metadata。不要手写 generated `pluxel.pluginPackages`、伪造 constructor dependency 或复制 package root export facts。

## Workbench UI package

有 UI 时，server Plugin 声明 literal entry：

```ts no-twoslash
const OrdersWorkbench = workbench.extension({
	contract: OrdersUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
```

`pluxel build` 才会发现 declaration 并生成独立 remote。server bundle 与 browser remote 分离；browser graph 不能导入 Node builtin、database schema、secret 或 Plugin implementation。

没有 UI declaration 时，不加载 Federation builder，也不创建 remote artifact。

## 数据库与 Node artifacts

- `defineDatabase()` 的 migrations/check artifact 随 package 发布，见 [数据库](../runtime/database.md)。
- `defineNodeModule()`/`defineWorkerTask()` 生成独立 Node artifact，见 [Node module 与 worker task](../runtime/node-artifacts.md)。
- 这些 declaration 必须能从 package source graph 静态提取，不能藏在动态 branch 中。

## 构建与发布检查

```sh
pnpm verify
pnpm pack --dry-run
```

`verify` 应依次覆盖 format、lint、typecheck、test 和 `pluxel build`。发布前再检查 pack 列表：

- 只有 `dist/` 等声明文件进入 npm package；
- default export target、types 和生成 artifact 都存在；
- 没有 source map、fixture、credential 或 workspace-only path 泄漏；
- peer dependency 与真正 runtime/provider boundary 一致；
- consumer 能只从 package root 安装和导入。

下一步：[编写第一个插件](../getting-started/index.md)。
