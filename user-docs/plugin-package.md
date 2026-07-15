# 开发和发布插件包

本文给出一个插件包从创建、配置、构建到发布的标准路径。插件类和运行时 API 见
[`plugin-authoring.md`](plugin-authoring.md)，测试见 [`testing.md`](testing.md)。

最省事的起点是 CLI 模板：

```sh
pluxel new --template plugin --name @acme/orders
cd orders
pnpm install
pnpm verify
```

模板同时生成 `docs/pluxel/` 和根 `AGENTS.md`；本地开发者与 coding agent 使用的规范就是当前这套
user docs，不维护一份容易漂移的模板专用教程。

已有 package 不需要重新生成；按本文校准目录、`package.json`、`tsconfig.json` 和
`tsdown.config.ts` 即可。

## 标准目录

一个可独立发布的插件 package 保持单一公开入口：

```text
package.json
tsconfig.json
tsdown.config.ts
vitest.config.ts
oxlint.config.ts
.oxfmtrc.json
.gitignore
src/
  orders.ts             package 公开入口和 OrdersPlugin constructor
  config.ts             config schema
  contracts.ts          browser-safe 共享类型（需要时）
  workbench-contract.ts browser-safe Workbench Contract（需要时）
  ui/                   Workbench remote 源码（需要时）
tests/
  orders.test.ts
```

先从一个入口开始。只有确实存在独立、稳定的消费边界时才增加 subpath export；不要按内部目录结构
逐个暴露文件。

## 安装依赖

插件运行时是 peer dependency，构建和测试工具只进入 dev dependencies：

```sh
pnpm add @pluxel/runtime --save-peer
pnpm add -D @pluxel/cli @pluxel/core @pluxel/rolldown @pluxel/test
pnpm add -D tsdown typescript vitest oxlint oxfmt
```

声明 Workbench UI 时再安装 Vite 和 UI peer：

```sh
pnpm add -D vite
pnpm add react react-dom --save-peer
```

插件依赖另一个插件 package 时，把版本放进 `devDependencies` 供本地类型检查和测试使用：

```sh
pnpm add -D pluxel-plugin-database pluxel-plugin-audit
```

源码中的 constructor 和 `optionalPlugin()` 声明才是 required/optional 的事实源。`pluxel build`
会据此生成发布时的 peer metadata；不要使用 `optionalDependencies` 表达插件可选关系。

普通第三方运行时库仍按 npm 语义管理：插件实现真正需要并私有使用的库放 `dependencies`，只在开发期
使用的工具放 `devDependencies`，需要与宿主共享 singleton 的库才放 `peerDependencies`。

## `package.json` 标准形状

下面是单入口插件包的完整骨架。版本号由 package manager 或发布流程写入，不要照抄示例版本：

```jsonc
{
	"$schema": "https://market.pluxel.dev/schema/package.json",
	"name": "@acme/pluxel-plugin-orders",
	"version": "0.1.0",
	"description": "Orders capability for Pluxel",
	"type": "module",
	"types": "./dist/index.d.mts",
	"exports": {
		".": {
			"types": "./dist/index.d.mts",
			"@pluxel/runtime-dynamic": "./src/orders.ts",
			"default": "./dist/index.mjs",
		},
		"./package.json": "./package.json",
	},
	"files": ["dist", "!**/*.map"],
	"scripts": {
		"build": "pluxel build",
		"lint": "oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error src tests tsdown.config.ts vitest.config.ts oxlint.config.ts",
		"lint:fix": "pnpm lint --fix",
		"format": "oxfmt -c .oxfmtrc.json --ignore-path .gitignore --write .",
		"format:check": "oxfmt -c .oxfmtrc.json --ignore-path .gitignore --check .",
		"test": "vitest run",
		"test:watch": "vitest",
		"typecheck": "tsc --noEmit --pretty false",
		"verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build",
	},
	"peerDependencies": {
		"@pluxel/runtime": "<compatible-version>",
	},
	"devDependencies": {
		"@pluxel/cli": "<compatible-version>",
		"@pluxel/core": "<compatible-version>",
		"@pluxel/rolldown": "<compatible-version>",
		"@pluxel/test": "<compatible-version>",
		"oxfmt": "<compatible-version>",
		"oxlint": "<compatible-version>",
		"tsdown": "<compatible-version>",
		"typescript": "<compatible-version>",
		"vitest": "<compatible-version>",
	},
	"publishConfig": {
		"exports": {
			".": {
				"types": "./dist/index.d.mts",
				"default": "./dist/index.mjs",
			},
			"./package.json": "./package.json",
		},
	},
}
```

这些字段各有明确所有者：

| 字段                                                 | 谁维护         | 规则                                                                |
| ---------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| `name`、`version`、`description`、license/repository | 作者或发布系统 | npm package 身份；名称需要符合宿主的插件发现规则                    |
| `type`、`types`、`exports`、`files`                  | 作者           | 对齐实际 `dist` 文件；只暴露稳定入口                                |
| `@pluxel/runtime` peer                               | 作者           | 插件和宿主共享同一 runtime，不打入插件 bundle                       |
| 普通 `dependencies` / `devDependencies`              | 作者           | 遵循普通 npm 运行期/开发期语义                                      |
| 其他插件的 peer、`peerDependenciesMeta`              | `pluxel build` | 根据源码声明同步；作者只需提供可用版本范围                          |
| `pluxel.pluginPackages`                              | `pluxel build` | 生成字段，不手写、不在 review 中人工排序                            |
| `publishConfig.exports`                              | 作者           | 发布时移除本地源码 condition，防止 consumer 直接执行 raw TypeScript |

`@pluxel/runtime-dynamic` condition 只服务受控的本地 dynamic development route。npm 发布产物通过
`publishConfig.exports` 只暴露编译后的 JS 和声明文件；不要发布通用 `source` condition。

## `tsconfig.json` 标准形状

TypeScript 只做类型检查，不负责生成插件产物：

```json
{
	"$schema": "https://json.schemastore.org/tsconfig",
	"compilerOptions": {
		"target": "ES2023",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"moduleDetection": "force",
		"lib": ["ES2023"],
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true,
		"verbatimModuleSyntax": true,
		"allowImportingTsExtensions": true,
		"resolveJsonModule": true,
		"isolatedModules": true,
		"customConditions": ["@pluxel/source", "@pluxel/runtime-dynamic"],
		"experimentalDecorators": true,
		"emitDecoratorMetadata": true
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

`experimentalDecorators` 和 `emitDecoratorMetadata` 让编辑器与 typecheck 理解作者模型；真正发布的 legacy
decorator transform 和 `design:paramtypes` 仍由 Pluxel 的 Rolldown pipeline 生成。不要用 `tsc`、`tsx`
或 Node type stripping 直接构建/运行插件源码。

## `tsdown.config.ts` 标准形状

推荐配置只描述 package 自己的入口和输出：

```ts
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

然后始终通过以下脚本构建：

```json
{
	"scripts": {
		"build": "pluxel build"
	}
}
```

`tsdown.config.ts` 是用户 override，不是完整构建器。`pluxel build` 会在它外层组合标准
`pluginPackage()` preset，统一加入：

- legacy decorator 与 constructor metadata transform；
- preprocessor、macro、config metadata 和 Pluxel lint guard；
- optional plugin semantic transform；
- Workbench declaration 提取和 remote build；
- 最终 decorator output guard；
- package dependency metadata transaction。

因此不要在用户配置里再次调用 `pluginPackage()`，不要复制 Pluxel plugin 数组，也不要自己配置 decorator
transform。重复安装 compiler plugin 会造成两次 transform、metadata 重复或开发/发布语义漂移。

推荐只输出 ESM。确有 CJS consumer 时可以使用 `format: ['esm', 'cjs']`；同一次多格式构建会共享一份
dependency facts，不需要自定义 metadata hook。增加格式后要同步检查 `exports` 指向实际文件。

### 安全的 override

可以覆盖 tsdown 的普通输出选项、追加普通 Rolldown plugin，或保留自己的 `onSuccess`：

```ts
import { defineConfig } from 'tsdown'
import { verifyGeneratedClient } from './scripts/verify-generated-client.ts'

export default defineConfig({
	entry: { index: 'src/orders.ts' },
	format: ['esm'],
	dts: { eager: true },
	sourcemap: true,
	clean: true,
	onSuccess: async (_config, signal) => {
		if (signal.aborted) return
		await verifyGeneratedClient()
	},
})
```

执行顺序是调用方基础 hook → Pluxel preset metadata hook → 用户 `onSuccess`。用户 hook 读取
`package.json` 时已经能看到同步后的 `pluxel.pluginPackages`。

不要使用 tsdown 的旧顶层 `external`、`noExternal` 或 `inlineOnly`；需要普通依赖覆盖时使用
`deps.neverBundle`、`deps.alwaysBundle` 和 `deps.onlyBundle`。通常不需要为 Pluxel runtime 或插件依赖手写
这些规则，preset 和 peer metadata 已拥有该边界。

## 依赖 metadata 如何生成

构建器只识别两种明确的作者声明：

```ts
import { BasePlugin, optionalPlugin, Plugin } from '@pluxel/runtime'
import { DatabasePlugin } from 'pluxel-plugin-database'

const Audit = optionalPlugin(() =>
	import('pluxel-plugin-audit').then(({ AuditPlugin }) => AuditPlugin),
)

@Plugin({ name: 'OrdersPlugin' })
export class OrdersPlugin extends BasePlugin {
	constructor(private readonly database: DatabasePlugin) {
		super()
	}

	override init() {
		this.plugins.use(Audit, (audit) => audit.registerSource(this))
	}
}
```

- concrete constructor parameter → `required`；
- module-level `optionalPlugin()` literal import → `optional`；
- 同一 package 同时出现时 `required` 胜出；
- 与 constructor / `optionalPlugin()` 声明无关的普通 static、type 或 dynamic import 不推断插件关系。

构建前，两个 provider 可以只存在于 `devDependencies`：

```json
{
	"devDependencies": {
		"pluxel-plugin-audit": "^2.0.0",
		"pluxel-plugin-database": "^3.0.0"
	}
}
```

构建后，工具会保留 dev dependency，并生成发布边界：

```json
{
	"peerDependencies": {
		"pluxel-plugin-audit": "^2.0.0",
		"pluxel-plugin-database": "^3.0.0"
	},
	"peerDependenciesMeta": {
		"pluxel-plugin-audit": {
			"optional": true
		}
	},
	"pluxel": {
		"pluginPackages": {
			"pluxel-plugin-audit": "optional",
			"pluxel-plugin-database": "required"
		}
	}
}
```

版本范围按 `peerDependencies` → `devDependencies` → `dependencies` 查找。检测到插件关系但找不到版本时，
构建直接失败；它不会猜 `latest`。检测到的插件会从 `dependencies` 移到 peer，旧生成 peer、optional
metadata 和 legacy `pluxel.dependOn` 会随源码删除而清理，`devDependencies` 保留。

semantic pass 会在 metadata 写回前就把检测到的 required/optional provider 标为 external，因此版本只在
`devDependencies` 中时，第一次构建也不会把 provider 打进插件 bundle。

这意味着 `package.json` review 应检查“源码声明是否正确”和“版本范围是否合理”，不应手工维护生成映射。

## 整理已有插件包

旧 package 按下面顺序收敛，不需要保留兼容构建配置：

1. 把 build script 改成 `pluxel build`；
2. 把 `tsdown.config.ts` 缩减为 entry、format、dts、sourcemap、clean、minify、treeshake 等输出配置；
3. 删除手工复制的 Pluxel compiler plugins、decorator transform 和 metadata hook；
4. 确保 `@pluxel/runtime` 位于 peer，其他插件至少在 peer/dev/dependencies 之一有明确版本；
5. 用 constructor 和 `optionalPlugin()` 表达真实依赖，不再维护 `pluxel.dependOn`；
6. 运行 `pnpm build`，review 自动生成的 peer、optional metadata 和 `pluxel.pluginPackages`；
7. 再运行一次 build，确认 `package.json` 不再变化，然后执行完整 `pnpm verify`。

不要同时在 `tsdown.config.ts` 调用 `pluginPackage()` 又通过 `pluxel build` 包装它。前者是底层 preset API，
后者已经负责 CLI context、metadata transaction 和 hook 组合；叠加会重复编译语义。

## 自定义插件命名约定

默认只把 package 名中以 `pluxel-plugin` 开头的部分识别为插件 package。组织使用自己的命名时，在
build/CI 环境设置逗号分隔前缀：

```sh
PLUXEL_PLUGIN_PREFIX=pluxel-plugin,acme-plugin pnpm build
```

需要把生成映射放到非默认 manifest 字段时：

```sh
PLUXEL_MANIFEST_FIELD=acme pnpm build
```

这会生成 `acme.pluginPackages`。一个组织应在 workspace 和 CI 统一设置，不要让本地与发布任务使用
不同前缀。`PLUXEL_TSDOWN_CONFIG` 可显式指定非标准配置文件；正常项目保留根目录
`tsdown.config.ts` 即可。

## Workbench UI 插件包

只有使用 `workbench.entry(import.meta.url, './ui/index.tsx')` 的插件需要 Vite。server entry 仍由 tsdown
构建到 `dist/index.mjs`，UI remote 单独输出到 `dist/workbench/<artifact>/`，不会混入 server bundle。

UI source 只能导入 browser-safe Contract、`@pluxel/runtime/workbench/contract`、
`@pluxel/runtime/workbench/ui` 和公开 UI peers；不能导入 Plugin、Context、server Extension 或 Node API。
完整边界见 [`plugin-authoring.md`](plugin-authoring.md#http-与-workbench-plane)。

## 构建、检查和发布

开发时：

```sh
pnpm test:watch
pnpm build -- --watch
```

需要查看最终合并的 tsdown 配置时：

```sh
pnpm exec pluxel build --debug
```

发布前按顺序运行：

```sh
pnpm verify
npm pack --dry-run
```

至少检查：

1. `dist/index.mjs` 和 `dist/index.d.mts` 存在，`exports` 没有指向缺失文件；
2. tarball 只包含 `files` 允许的产物，没有源码、测试、缓存或 sourcemap；
3. `@pluxel/runtime` 和插件依赖没有被打入独立插件 bundle；
4. required/optional peer 与 `pluxel.pluginPackages` 符合源码；
5. optional provider 缺失时 consumer 仍能启动；provider 损坏时有明确失败诊断；
6. 有 Workbench UI 时 remote artifact 存在；无 UI 时不应产生 Workbench 产物；
7. `pnpm build` 连续执行两次后 `package.json` 不再变化。

插件 package 发布后，宿主安装 required peer；optional peer 只有需要对应增强能力时才安装。static
application 必须重新构建才能改变 optional provider 的固定闭包，dynamic host 则在 package 安装或失效后重试
active optional request。
