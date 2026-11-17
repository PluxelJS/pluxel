---
title: CLI 与工具链
description: 了解脚手架、插件构建、应用执行、HMR、源码联调和发行检查分别由谁负责。
---

Pluxel CLI（`@pluxel/cli`）是贯穿工作区初始化、代码生成、构建转换、本地调试与包发布的核心命令行工具。

## CLI 命令概览

- **创建脚手架工程**：`vp create @pluxel [directory]`
- **查阅项目离线文档**：`pluxel docs [path]`
- **生成新插件包**：`pluxel new --name @scope/plugin [dir]`
- **构建插件包**：`pluxel build`
- **数据库迁移维护**：`pluxel database generate/check/rebase`（见 [数据库开发](../plugin-development/database.md)）
- **应用发行物打包与校验**：`pluxel distribution create/inspect/verify`
- **发布 npm 包并同步市场**：`pluxel publish --webhook`
- **开发控制台与 HMR 批次管理**：`pluxel dev status/hmr/run/result/cancel`（见 [开发控制台](./dev-console.md)）
- **本地多仓联调管理**：`pluxel source register/list/unregister/doctor/build/install`
- **工作区依赖治理与 Catalog 同步**：`pluxel pncat add/remove/migrate/clean` 与 `pluxel workspace sync`

<span id="安装分层"></span>

## CLI 安装与解析层级

为了保障不同环境的一致性，CLI 具备分层查找能力：

- **项目内本地依赖**：建议在 Monorepo 根目录下作为 devDependencies 安装：
  ```sh
  npx nypm add -D @pluxel/cli
  ```
- **全局安装**：全局安装的 CLI 进入已存在本地 `@pluxel/cli` 的项目时，会自动将执行权移交给本地版本，确保与当前工程的版本锁定一致。
- **源码工作区联调**：在本地开发 Pluxel 框架源码时，通过 `pluxel source` 命令族注册本地 checkout。

<span id="构建入口"></span>

## 构建与打包

- **独立插件构建**：在插件子包目录执行 `pluxel build`。工具链会自动调用 `@pluxel/rolldown` 提取依赖元数据清单（Metadata）、执行 TypeScript 编译并生成符合 ESM 规范的交付产物。
- **宿主应用构建**：宿主工程在 `tsdown.config.ts` 中配置 `pluxel()` 插件，将前端静态资产、服务端 Node 模块与依赖打包为生产发行物。

<span id="自定义本地-plugin-模板"></span>

## 自定义本地插件模板

`pluxel new` 除了内置的通用插件模板外，也支持基于团队本地目录生成：

```sh
pluxel new --template ./templates/custom-plugin --name @acme/orders
```

模板根目录需包含 `pluxel-template.jsonc` 声明文件：

```jsonc
{
	"schemaVersion": 1,
	"id": "custom-plugin",
	"packageManager": { "name": "pnpm" },
	"prompts": [
		{
			"name": "description",
			"type": "text",
			"message": "插件包描述",
			"default": "Pluxel plugin: {{ className }}Plugin",
		},
	],
}
```

- 普通文件按字节完整拷贝；
- 以 `.tpl` 结尾的文件在输出时会移除后缀，并将其中的 `{{ key }}` 与 `{{ json key }}` 变量替换为命令行输入的具体值。

<span id="source-build-boundary"></span>

## 源码转换与环境边界

在 Vite 开发环境中，`@pluxel/host-vite` 通过专用的 Vite 插件链完成以下操作：

1. **语义降阶（Semantic Lowering）**：识别 `@Plugin` 装饰器，提取构造函数依赖参数与 Part 树元数据。
2. **多环境隔离**：将 Pluxel 服务端代码运行在专用 Vite 环境中，与普通的前端浏览器代码解耦。
3. **逻辑源空间（Source Spaces）**：支持将外部目录映射为逻辑插件命名空间。

```ts no-twoslash
import { pluginSourceVitePlugins } from '@pluxel/rolldown/vite'

const plugins = pluginSourceVitePlugins({
	root: '/srv/my-app',
	sourceSpaces: [{ name: 'managed', root: 'plugins/managed' }],
})
```

<span id="hmr-失败与自动恢复"></span>

## HMR 状态管理与更新恢复

Pluxel 的热更新机制对插件运行意图具有持久化记忆能力：

- **编译或求值错误阶段**：若源码存在语法错误或导入缺失，系统会拦截该批次并保持旧版本插件继续对外服务。
- **运行期初始化阶段**：若新插件的配置校验或 `init()` 抛出异常，该节点会被标记为不可用，但不会破坏其他运行中的健康插件。在修复代码并保存后，系统会在下一次文件变更时自动尝试恢复该节点。
- **批次状态展示**：在控制台顶部会展示最新一次 HMR 批次的结果与触发文件路径，便于快速定位引发更新失败的具体代码。
