---
title: Pluxel Oxlint 规则
description: 用静态规则检查 Plugin 元数据、配置、资源归属和生命周期约束。
---

# Pluxel Oxlint 规则

普通 Oxlint 检查 JavaScript 和 TypeScript 代码质量；`@pluxel/rolldown/oxlint` 继续检查只有 Pluxel 才理解的 Plugin 规则，例如元数据位置、配置读取时机和资源归属。

## 标准配置

```ts twoslash
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
	rules: { ...(prefixPluxelRuleSet(pluxelRules) as RuleMap) },
})
```

## 重点规则

| 规则                                             | 保护什么                         | 典型修复                     |
| ------------------------------------------------ | -------------------------------- | ---------------------------- |
| `plugin-base-class-requires-plugin-registration` | concrete Plugin 有 marker        | 添加 `@Plugin()`             |
| `plugin-constructor-canonical-dependencies`      | required edge 有 root provenance | 从 package root value-import |
| `configs-use-top-level-class`                    | config metadata 可提取           | 把 field 放到 class 顶层     |
| `configs-use-no-private-field`                   | runtime 可以注入 config          | 不使用 `#private`            |
| `configs-use-no-early-read`                      | config 已完成注入                | 在 `init()` 之后读取         |
| `configs-use-no-redefault`                       | schema 是唯一默认值来源          | 移除额外的 fallback          |
| `configs-use-single-object-schema`               | 每个 Plugin 只有一个 schema      | 合并成一个 object            |
| `plugin-no-process-exit`                         | 退出策略属于 host                | 抛出事实错误                 |
| `no-direct-logtape-get-logger`                   | logger 保留 Context ownership    | 使用 `ctx.logger`            |

## Error log

```ts no-twoslash
try {
	await sync()
} catch (error) {
	this.ctx.logger.error('sync failed', { error })
}
```

不要插值 error、只记录 `error.message`，也不要把 `failure` 另造一套错误字段。

## 验证顺序

这些规则运行在 Pluxel/Vite build-correctness pipeline 中，依赖 package-root provenance 和 source semantics；普通 `tsc` 无法替代。

1. 运行 `pnpm lint:fix`，应用安全的 import、字段名和 re-default 修复。
2. 按 semantic 诊断修正 Plugin metadata、配置和 lifecycle 边界。
3. 运行 `pnpm verify`，确认没有 unused disable。

不要用大范围 disable 绕过规则。若确有误报，保留最小范围、说明原因，并让 unused-disable 检查仍然开启。
