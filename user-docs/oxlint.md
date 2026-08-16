# Pluxel Oxlint 规则

`@pluxel/rolldown/oxlint` 补充通用 Oxlint 无法理解的 Pluxel 作者约束。这些规则优先保护
metadata、生命周期、所有权和 contract，而不是统一个人代码风格。

## 推荐配置

CLI monorepo 模板已经生成这份集成。手动配置时：

```ts
import { defineConfig, type OxlintConfig } from 'oxlint'
import {
	createPluxelJsPluginEntry,
	pluxelOxlintIgnorePatterns,
	pluxelRules,
	prefixPluxelRuleSet,
} from '@pluxel/rolldown/oxlint'

type RuleMap = NonNullable<OxlintConfig['rules']>

export default defineConfig({
	jsPlugins: [createPluxelJsPluginEntry()],
	ignorePatterns: [...pluxelOxlintIgnorePatterns],
	rules: {
		...(prefixPluxelRuleSet(pluxelRules) as RuleMap),
	},
})
```

`prefixPluxelRuleSet(pluxelRules)` 默认以 error 启用全部规则。建议 lint 命令同时启用
`--report-unused-disable-directives-severity=error`，避免抑制项永久失效。

## Plugin

| 规则                                             | 保护的约束                                             | 推荐修复                                                              |
| ------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `plugin-base-class-requires-plugin-registration` | 具体 Plugin 必须带薄 `@Plugin` marker                  | 添加 `@Plugin({ displayName })`；抽象基类保持 `abstract`              |
| `plugin-constructor-canonical-dependencies`      | required edge 必须能证明 package-root value provenance | 从 provider package root direct value-import named Plugin             |
| `plugin-no-process-exit`                         | 进程策略属于 host                                      | 启动时抛错或报告 operational error                                    |
| `plugin-no-removed-feature-api`                  | Plugin 内部只保留普通对象/effects                      | 用普通 class/function、effects scope 或独立 Plugin 代替内部 lifecycle |

## 配置

| 规则                               | 保护的约束                                  | 推荐修复                                                                 |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `configs-use-top-level-class`      | 工具链需要稳定提取 config metadata          | 将 plugin class 和 `configs.use()` field 移到 module top level           |
| `configs-use-no-private-field`     | runtime 无法注入 JavaScript `#private` slot | 使用普通的 `private readonly config` field                               |
| `configs-use-no-early-read`        | config 在构造后、启动前才完成注入           | 只在 `init()` 或后续 method 读取                                         |
| `configs-use-no-redefault`         | schema 已负责默认值和归一化                 | 把默认值写进 schema，移除额外的空值或逻辑或 fallback；部分情况可自动修复 |
| `configs-use-single-object-schema` | 每个具体 Plugin 只有一个 object schema      | 合并到一个 object schema，用嵌套字段表达 section                         |
| `configs-no-removed-dsl`           | config 只有一个作者声明                     | 使用一个 `this.configs.use(ObjectSchema)` field                          |

## 日志与 import 边界

| 规则                           | 保护的约束                                          | 推荐修复                                                              |
| ------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- |
| `log-no-rendered-error`        | 保留原始 error 的 stack、cause 和结构化查询能力     | 使用 `logger.error('sync failed', { error })`                         |
| `log-canonical-error-prop`     | error 字段必须一致且保存原对象                      | 使用唯一的 `error` 或 `err` 字段；字段重命名通常可自动修复            |
| `no-direct-logtape-get-logger` | logger 必须保留 plugin Context 和 cleanup ownership | 使用 `ctx.logger` 或 `ctx.logger.getDebugChannel(topic)`              |
| `no-workspace-root-import`     | build-time helper 依赖必须显式且可裁剪              | 从 `/workspace/fs`、`/info`、`/vite` 或 `/oxlint` 等明确 subpath 导入 |

正确的错误日志：

```ts
try {
	await sync()
} catch (error) {
	this.ctx.logger.error('sync failed', { error })
}
```

不要插值 `${error}`、记录 `{ failure: error }`，或提前转换为 `error.message`/`String(error)`。

## 修复顺序

1. 先运行 `pnpm lint:fix` 处理安全的 import、字段名和 re-default 修复。
2. 再按诊断调整代码所有权；metadata 和生命周期规则不适合机械猜测。
3. 最后运行 `pnpm verify`。不要为通过构建而广泛 disable Pluxel rules；确有误报时用最小范围抑制，
   写明原因，并保留 unused-disable 检查。
