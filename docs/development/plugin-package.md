---
title: 开发和发布插件包
description: 创建一个可以独立构建、测试和发布的 Pluxel 插件包。
---

当需要将开发的插件分发给其他工程或发布至 npm 时，可以使用 CLI 生成标准的独立插件包结构。

## 创建插件包工程

使用官方模板生成一个独立的插件包：

```sh
vp dlx @pluxel/cli@1 new --template plugin --name @acme/orders
cd orders
vp run verify
vp pm pack --dry-run
```

- 该命令会自动规范化包名为 `@acme/pluxel-plugin-orders`。
- 输出目录为 `orders/`，核心代码位于 `src/orders.ts`，主导出类为 `OrdersPlugin`。
- 执行 `vp run verify` 可依次完成代码格式化、类型检查、测试与全量构建。

## 标准目录组织

```text
src/
  orders.ts            插件核心实现（继承 BasePlugin 并使用 @Plugin 装饰）
  config.ts            服务与共享安全的配置 Schema
  workbench.ts         可选的控制台面板声明（Workbench Definition）
  ui/                  可选的控制台前端界面组件
tests/
  orders.test.ts       基于 @pluxel/test 的插件集成测试
package.json           包清单与依赖声明
tsconfig.json          TypeScript 编译配置
tsdown.config.ts       tsdown 打包规则
vite.config.ts         全包任务调度（Vite Task）
```

## 插件身份与导出规范

- **权威身份**：插件的全局身份由其公开的 npm 包入口与具名导出（Named Export）共同决定，而非类名或 `displayName`。
- **调用约定**：消费者必须直接从该包的根入口引入插件，例如：
  ```ts
  import { OrdersPlugin } from '@acme/pluxel-plugin-orders'
  ```
- **服务配套插件**：如果一个服务包需要附带管理插件，可统一放在 `./plugins` 子路径导出（如 `@pluxel/services/plugins`），并在 `package.json` 的 `exports` 中显式声明该子路径。

## 包清单配置（`package.json`）

```json
{
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
	"peerDependencies": {
		"@pluxel/core": "catalog:"
	}
}
```

- 核心框架库（如 `@pluxel/core`）及其他必需的上游插件通常声明在 `peerDependencies` 中。
- `@pluxel/hmr` 条件用于在 Monorepo 源码联调时让 Vite 直接读取 TypeScript 源文件，`default` 则指向生产构建生成的 ESM 产物。

<span id="依赖-metadata-如何生成"></span>

## 自动依赖元数据生成

执行 `pluxel build` 时，构建系统会静态分析插件及其包含的全部 Part 依赖拓扑，并在打包产物中自动写入依赖元数据清单（Metadata）：

- 自动提取构造函数中的依赖注入标记；
- 聚合 Part 树中的依赖，自动去重并确定必需（required）与可选（optional）边界；
- 若代码中注入的外部插件未在 `package.json` 的 `peerDependencies` 中声明，构建时会报错提醒补齐依赖。

<span id="构建与发布检查"></span>

## 构建与发布检查清单

在执行 `npm publish` 或 `pluxel publish` 之前，执行以下验证步骤：

```sh
# 1. 运行完整代码门禁
vp run verify

# 2. 模拟打包并检查打包文件列表
vp pm pack --dry-run

# 3. 发布并触发插件市场同步
vp exec pluxel publish --webhook
```

发布前确认项：

- `dist/` 目录下正确生成了 `.mjs` 模块及 `.d.ts` 类型声明文件；
- 临时文件、测试夹具、敏感凭据或源码映射未被误打包；
- `peerDependencies` 版本范围符合目标运行环境的要求。
