---
title: 开发和发布插件包
description: 创建一个可以独立构建、测试和发布的 Pluxel 插件包。
---

需要把插件提供给其他应用时，用 CLI 生成可独立测试、构建和打包的 npm 包。只想在示例应用里写业务，先看[第一个插件](../getting-started/first-plugin.md)。

准备 Node.js 24+、pnpm 11，在空的工作目录运行：

```sh
pnpm dlx @pluxel/cli@1 new --template plugin --name @acme/orders
cd orders
pnpm verify
pnpm pack --dry-run
```

这个名称会规范化为 npm 包 `@acme/pluxel-plugin-orders`，输出目录为 `orders/`，实现文件为 `src/orders.ts`，导出类为 `OrdersPlugin`。

`verify` 应完成治理、格式、lint、类型、测试和构建检查；pack 列表应包含 `dist/index.mjs`、类型声明及插件声明需要的生成文件。已有 workspace 固定 CLI 时，用 `pnpm exec pluxel new`。

官方模板默认完成依赖安装；需要只生成文件时传入 `--no-install`。local template 则默认不执行安装，必须显式传入
`--install` 才会运行 package manager。编写 manifest 与 `.tpl` 文件前先阅读[自定义本地 Plugin 模板](./tooling.md#自定义本地-plugin-模板)。

CLI 生成的插件 TypeScript 配置包含 `ESNext.Disposable`，供 Pluxel 的资源清理类型使用；自定义 `compilerOptions.lib` 时也应保留它。

## 标准目录

CLI 先生成实现和测试文件；拆分配置或添加管理界面后，可以扩展为下面的布局，`config.ts`、`workbench.ts` 和 `ui/` 并非默认生成文件：

```text
src/
  orders.ts            Plugin implementation
  config.ts            server/shared-safe schema
  index.ts             如果模板使用独立 root barrel
  workbench.ts         可选 Workbench definition
  *.md                 可选 Workbench Content source
  ui/                  可选 Workbench browser entry
tests/
  orders.test.ts
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
- Workbench definition/API、worker adapter 等 plugin-free 模块可以有独立 subpath，但不得形成第二个模糊 plugin-bearing root。

对于可发布包，包名或包根导出名改变会得到新的 Plugin definition identity；二者不变时，内部源码文件移动不改变这个身份。持久 config/runtime state 不按旧 class name 自动迁移。

## 包清单的关键字段

下面只摘录关键字段；完整依赖、catalog 和 scripts 使用 CLI 生成的文件，不要用这个片段覆盖整个 manifest：

```json
{
	"$schema": "https://market.pluxel.dev/schema/package.json",
	"name": "@acme/pluxel-plugin-orders",
	"version": "0.1.0",
	"type": "module",
	"exports": {
		".": {
			"@pluxel/hmr": "./src/orders.ts",
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
		"lib": ["ES2023", "ESNext.Disposable"],
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
	"include": [
		"src/**/*.ts",
		"src/**/*.tsx",
		"tests/**/*.ts",
		"tests/**/*.tsx",
		"tsdown.config.ts",
		"vitest.config.ts",
		"oxlint.config.ts"
	]
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
		index: 'src/orders.ts',
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
- 可选 Workbench Content artifact、MF2 producer 与 Node/worker/database artifacts。

构建失败不会提交部分 metadata。不要手写 generated `pluxel.pluginPackages`、伪造 constructor dependency 或复制 package root export facts。

## Workbench 内容

Workbench 的声明和 API 类型放在可供浏览器导入的 `workbench.ts`，Plugin implementation 与 `publish()` 留在插件实现文件中。新页面只从
一条标准路径开始：

- 说明、bounded live state、按钮或一次性表单：[Content 配方](../workbench/content.md)；
- 自定义 React UI、分页、progress/cancel 或复杂交互：[View 配方](../workbench/view.md)；
- provider-owned UI 由 consumer 决定 placement：[Attachment 配方](../workbench/composition.md)。

不要为普通 config 复制一套页面；使用 `configs.use()` 的标准 Config UI。动态 item、权限和业务状态通过 Plugin API 返回，
不通过动态增删 Workbench entry 表达。

Content-only package 不加载 Federation builder、不生成 remote entry，也不要求 React/Mantine compatibility；schema 与 handler
只存在于 server binding。完整 View 的 browser graph 不得导入 Node builtin、database handle、secret 或 Plugin implementation。

`pluxel build` 在 TypeScript 擦除前提取 owning Plugin definition、entry key 和 literal source，生成一个标准 MF2
producer、每个 declaration 的 React Bridge expose 和 `mf-manifest.json`。作者不手写 remote name、expose、shared
或 Bridge wrapper。Server bundle 与 browser producer 分离。

同一 definition 可以同时含 Content 与 View；发布包和 static/distribution build 中，两类 artifact 必须全部构建成功后再作为
一个 revision 提交。开发 host 会先发布 Content/topology，再在后台补齐缺失 producer；未就绪 View 显示构建中，
producer 失败时在对应位置显示错误。
没有 renderer declaration 时，不加载 Federation builder，也不创建 producer。

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

下一步：[编写第一个插件](../getting-started/first-plugin.md)。
