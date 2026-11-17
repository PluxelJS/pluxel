---
title: Pluxel Oxlint 规则
description: 用静态规则检查 Plugin 元数据、配置、资源归属和生命周期约束。
---

`@pluxel/rolldown/oxlint` 提供了一套专用于检查 Pluxel 插件规范与生命周期约束的 Oxlint 静态分析规则集，能够在编译与提交阶段识别插件装饰器、配置 Schema 定义、日志调用及资源归属问题。

由脚手架生成的工程默认已配置好该规则集，可通过以下命令执行检查：

```sh
vp lint
vp check --fix
```

## 标准配置（`oxlint.config.ts`）

在项目根目录下创建 `oxlint.config.ts`：

```ts twoslash
import type { OxlintConfig } from 'vite-plus/lint'
import {
	createPluxelJsPluginEntry,
	pluxelOxlintIgnorePatterns,
	pluxelRules,
	prefixPluxelRuleSet,
} from '@pluxel/rolldown/oxlint'

type RuleMap = NonNullable<OxlintConfig['rules']>

export default {
	jsPlugins: [createPluxelJsPluginEntry()],
	ignorePatterns: [...pluxelOxlintIgnorePatterns],
	rules: { ...(prefixPluxelRuleSet(pluxelRules) as RuleMap) },
} satisfies OxlintConfig
```

在 `vite.config.ts` 中引用该配置：

```ts no-twoslash
import { defineConfig } from 'vite-plus'
import lint from './oxlint.config'

export default defineConfig({ lint })
```

## 核心规则清单

| 规则名称                                         | 校验目的                                          | 推荐修复方式                                              |
| :----------------------------------------------- | :------------------------------------------------ | :-------------------------------------------------------- |
| `plugin-base-class-requires-plugin-registration` | 确保具体插件类添加了必要的注册装饰器              | 添加 `@Plugin()` 装饰器                                   |
| `plugin-constructor-canonical-dependencies`      | 依赖注入应从包公开根入口引入，保证类型溯源        | 从包根路径进行 `value-import`                             |
| `configs-use-top-level-class`                    | 确保配置字段位于类的顶层声明中，以便元数据提取    | 将配置字段提升至类声明顶层                                |
| `configs-use-no-private-field`                   | 运行时需注入配置，禁止使用 JS 原生私有字段（`#`） | 改用 TypeScript `private` 访问修饰符                      |
| `configs-use-no-early-read`                      | 防止在构造函数中过早读取尚未注入的配置            | 将配置访问逻辑移至 `init()` 或后续业务方法中              |
| `configs-use-no-redefault`                       | 默认值应集中在 Schema 中定义，避免逻辑分散        | 移除二次回退（如 `?? 'default'`），在 Schema 中指定默认值 |
| `configs-use-single-object-schema`               | 插件仅支持挂载单个配置 Schema 对象                | 将多个配置项合并为一个顶层 Object Schema                  |
| `plugin-no-process-exit`                         | 插件内部禁止随意调用 `process.exit()`             | 抛出带有明确原因的异常，交由宿主生命周期处理              |
| `no-direct-logtape-get-logger`                   | 日志器需保持与插件 Context 绑定的所有权           | 使用当前插件上下文的 `this.ctx.logger`                    |

## 日志错误记录规范

在捕获异常并记录日志时，建议将错误对象作为属性传递，便于日志收集平台保留完整的堆栈信息与错误类型：

```ts no-twoslash
try {
	await sync()
} catch (error) {
	this.ctx.logger.error('同步数据失败', { error })
}
```

避免仅记录 `error.message` 导致丢失原始错误调用栈。
