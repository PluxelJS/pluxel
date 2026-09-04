import { highlight } from 'fumadocs-core/highlight'
import * as Twoslash from 'fumadocs-twoslash/ui'
import { PluginShowcaseClient, type ShowcaseExample } from './plugin-showcase-client'

const examples = [
	{
		code: `import { HealthPlugin } from '@acme/health' // 值导入：提供必需依赖的来源
import type { AuditPlugin } from '@acme/audit' // 类型导入：不会加载可选插件
const Audit = definePluginRef<AuditPlugin>() // 模块级引用：声明可选依赖
@Plugin()
class StatusPlugin extends BasePlugin {
  constructor(readonly health: HealthPlugin) { super() } // 构造器参数：注入必需依赖
  protected override init() {
    // init 中的直接语句：消费可选依赖
    this.plugins.use(Audit, (audit) => audit.attach(this))
  }
  status() { return this.health.status() } // 直接调用必需依赖
}`,
		description: 'Health 缺席会阻塞 Status；Audit 缺席不阻塞，出现、消失或替换时重启 consumer。',
		href: '/docs/getting-started/plugin-model',
		label: '依赖',
		packageName: '@acme/health + @acme/audit → src/status.ts',
		status: '必需 + 可选 → 同一依赖图',
		twoslash: false,
	},
	{
		code: `class CachePart extends PluginPart<SearchPlugin> {
  constructor(private readonly backend: CachePlugin) { super() }
  protected override init() {
    const cache = this.backend.createCache()
    return () => cache.dispose()
  }
}
@Plugin()
class SearchPlugin extends BasePlugin {
  // 静态 owner-bound composition，不建立第二个 Plugin node
  private readonly cache = this.parts.use(CachePart)
}`,
		description:
			'Part 隔离 config、registration 和 cleanup，但始终跟随 owning Plugin 一起启动、失败和重启。',
		href: '/docs/getting-started/plugin-parts',
		label: '内部组成',
		packageName: 'src/search.ts',
		status: 'Part → owner generation',
		twoslash: false,
	},
	{
		code: `@Plugin()
class SamplerPlugin extends BasePlugin {
  protected override init() {
    const timer = setInterval(() => this.sample(), 1_000)

    // 登记到当前 generation：停止、回滚或 HMR 时统一回收
    this.ctx.effects.defer(
      () => clearInterval(timer),
      { tag: 'sampler' },
    )
  }
}`,
		description: '副作用登记到当前 generation；停止、启动回滚和 HMR replacement 都走同一套回收。',
		href: '/docs/getting-started/plugin-model',
		label: '回收',
		packageName: 'src/sampler.ts',
		status: 'generation → 统一回收',
		twoslash: false,
	},
	{
		code: `type Schema<T> = { output: T }
declare const v: {
  string(): Schema<string>
  optional<T>(schema: Schema<T>, fallback: T): Schema<T>
  object<T>(shape: T): Schema<{ [K in keyof T]: T[K] extends Schema<infer V> ? V : never }>
}
declare const Plugin: (...args: unknown[]) => any
declare class BasePlugin {
  configs: { use<T>(schema: Schema<T>): Readonly<T> }
}
// ---cut---
const StatusConfig = v.object({
  label: v.optional(v.string(), 'ready'), // 同一字段还可携带 Workbench 元数据
})

@Plugin()
class StatusPlugin extends BasePlugin {
  config = this.configs.use(StatusConfig)
  // ^?
}

// 同一份 schema 贯穿默认值、校验与表单`,
		description: '一份 schema 同时给出默认值、运行时校验、冻结输出和 Workbench 表单。',
		href: '/docs/getting-started/configuration',
		label: '配置',
		packageName: 'src/config.ts → src/plugins.ts',
		status: 'Schema → 全链路配置',
		twoslash: true,
	},
	{
		code: `type PluginClass<T> = abstract new (...args: any[]) => T
declare class StatusPlugin {
  status(): { ready: true; label: string }
}
declare interface RuntimeTestHost {
  start<T>(plugin: PluginClass<T>): Promise<T>
  require<T>(plugin: PluginClass<T>): T
  [Symbol.asyncDispose](): Promise<void>
}
declare const createRuntimeTestHost: () => RuntimeTestHost
// ---cut---
import { expect, it } from 'vitest'

it('运行完整的 Plugin graph', async () => {
  await using host = createRuntimeTestHost()
  const status = (await host.start(StatusPlugin)).status()
  //    ^?
  expect(status).toEqual({ ready: true, label: 'ready' })
})

// 当前作用域退出：停止依赖图并回收 effects`,
		description: '测试运行同一张依赖图；作用域退出后按所有权停止 Plugin 并释放 effects。',
		href: '/docs/development/testing',
		label: '测试',
		packageName: 'tests/status.test.ts',
		status: '构建语义 → 生命周期',
		twoslash: true,
	},
] as const

export async function PluginShowcase() {
	// 让 TypeScript compiler 留在 Node 侧，避免进入 RSC bundle。
	const twoslashPackage = 'fumadocs-twoslash'
	const { transformerTwoslash } = await import(/* @vite-ignore */ twoslashPackage)
	const highlighted: ShowcaseExample[] = await Promise.all(
		examples.map(async (example) => ({
			description: example.description,
			highlighted: await highlight(example.code, {
				defaultColor: false,
				lang: 'ts',
				themes: {
					light: 'github-light',
					dark: 'github-dark',
				},
				...(example.twoslash
					? {
							components: Twoslash,
							meta: { __raw: 'twoslash' },
							transformers: [transformerTwoslash()],
						}
					: {}),
			}),
			href: example.href,
			label: example.label,
			packageName: example.packageName,
			status: example.status,
		})),
	)

	return <PluginShowcaseClient examples={highlighted} />
}
