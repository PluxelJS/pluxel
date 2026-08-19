'use client'

import { Link } from 'fumapress/client'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'

const examples = [
	{
		code: `@Plugin({ displayName: 'Status' })
export class StatusPlugin extends BasePlugin {
  private config = this.configs.use(StatusConfig)

  override init() {
    this.ctx.http.plugin.routes((app) =>
      app.get('/status', () => ({
        label: this.config.label,
      })),
    )
  }
}`,
		description: '一个 class 就是一个 Plugin。配置和 HTTP route 都绑定当前实例，重载或停止时自动撤销。',
		href: '/docs/getting-started',
		label: 'Plugin',
		packageName: 'src/StatusPlugin.ts',
		status: '直接运行',
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
		description: '同一份 Valibot schema 同时提供 TypeScript 类型、默认值、运行时校验和 Workbench 表单。',
		href: '/docs/getting-started/configuration',
		label: '配置',
		packageName: 'src/config.ts',
		status: '无需重复类型',
	},
	{
		code: `it('starts and serves HTTP', async () => {
  await withRuntimeHost(async (host) => {
    host.add(StatusPlugin)
    host.cfg(StatusPlugin).set({ label: 'healthy' })
    host.cfg(StatusPlugin).enable()

    await host.commit()
    expect(host.require(StatusPlugin)).toBeDefined()
  })
})`,
		description: '测试经过真实语义转换和生命周期；callback 结束后 host 自动关闭，也会验证资源清理。',
		href: '/docs/development/testing',
		label: '测试',
		packageName: 'tests/StatusPlugin.test.ts',
		status: '真实 Runtime',
	},
] as const

export function PluginShowcase() {
	const [activeIndex, setActiveIndex] = useState(0)
	const active = examples[activeIndex]

	function moveTab(index: number, target: EventTarget & HTMLButtonElement) {
		const nextIndex = (index + examples.length) % examples.length
		setActiveIndex(nextIndex)
		const nextTab = target.parentElement?.children[nextIndex]
		if (nextTab instanceof HTMLButtonElement) nextTab.focus()
	}

	return (
		<div className="pluxel-runtime-window" aria-label="Plugin 开发示例">
			<div className="pluxel-showcase-tabs" role="tablist" aria-label="选择开发步骤">
				{examples.map((example, index) => (
					<button
					key={example.label}
					type="button"
					role="tab"
					id={`pluxel-plugin-tab-${index}`}
					aria-selected={index === activeIndex}
					aria-controls="pluxel-plugin-example"
					tabIndex={index === activeIndex ? 0 : -1}
					onClick={() => setActiveIndex(index)}
					onKeyDown={(event) => {
						if (event.key === 'ArrowRight') moveTab(index + 1, event.currentTarget)
						else if (event.key === 'ArrowLeft') moveTab(index - 1, event.currentTarget)
						else if (event.key === 'Home') moveTab(0, event.currentTarget)
						else if (event.key === 'End') moveTab(examples.length - 1, event.currentTarget)
						else return
						event.preventDefault()
					}}
					>
						{example.label}
					</button>
				))}
			</div>
			<div className="pluxel-showcase-meta">
				<code>{active.packageName}</code>
				<span>{active.status}</span>
			</div>
			<pre
				id="pluxel-plugin-example"
				className="pluxel-code"
				role="tabpanel"
				aria-labelledby={`pluxel-plugin-tab-${activeIndex}`}
			>
				<code>{active.code}</code>
			</pre>
			<div className="pluxel-showcase-footer">
				<p>{active.description}</p>
				<Link href={active.href}>
					查看文档 <ArrowRight aria-hidden="true" />
				</Link>
			</div>
		</div>
	)
}
