import { highlight } from 'fumadocs-core/highlight'
import { PluginShowcaseClient, type ShowcaseExample } from './plugin-showcase-client'

const examples = [
	{
		code: `@Plugin({ displayName: 'Health' })
export class HealthPlugin extends BasePlugin {
  status() {
    return { ready: true }
  }
}

@Plugin({ displayName: 'Status' })
export class StatusPlugin extends BasePlugin {
  constructor(private health: HealthPlugin) { super() }
  private config = this.configs.use(StatusConfig)

  status() {
    return {
      ...this.health.status(),
      label: this.config.label,
    }
  }
}`,
		description:
			'StatusPlugin 直接注入 HealthPlugin。构造函数参数就是依赖声明，两者的启动顺序和实例类型不需要另写配置。',
		href: '/docs/getting-started',
		label: '依赖',
		packageName: 'src/plugins.ts',
		status: '类型即依赖',
	},
	{
		code: `export const StatusConfig = v.object({
  label: v.optional(
    v.pipe(
      v.string(),
      f.formMeta({ label: '状态标签' }),
      f.stringMeta({}),
    ),
    'ready',
  ),
})`,
		description:
			'同一份 Valibot schema 同时提供 TypeScript 类型、默认值、运行时校验和 Workbench 表单。',
		href: '/docs/getting-started/configuration',
		label: '配置',
		packageName: 'src/config.ts',
		status: '无需重复类型',
	},
	{
		code: `it('starts plugin dependencies', async () => {
  await withRuntimeHost(async (host) => {
    host.add(StatusPlugin)
    host.cfg(StatusPlugin).set({ label: 'healthy' })
    host.cfg(StatusPlugin).enable()

    await host.commit()
    expect(host.require(HealthPlugin)).toBeDefined()
    expect(host.require(StatusPlugin)).toBeDefined()
  })
})`,
		description:
			'测试经过真实语义转换和生命周期；callback 结束后 host 自动关闭，也会验证资源清理。',
		href: '/docs/development/testing',
		label: '测试',
		packageName: 'tests/StatusPlugin.test.ts',
		status: '真实 Runtime',
	},
] as const

export async function PluginShowcase() {
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
			}),
			href: example.href,
			label: example.label,
			packageName: example.packageName,
			status: example.status,
		})),
	)

	return <PluginShowcaseClient examples={highlighted} />
}
