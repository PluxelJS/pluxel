'use client'

import { Link } from 'fumapress/client'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'

const examples = [
	{
		code: `export class Customers extends BasePlugin {
  constructor(
    private http: WretchPlugin,
  ) { super() }

  find(id: string) {
    return this.http.client
      .url('https://api.example.com')
      .get(\`/customers/\${id}\`)
      .json<Customer>()
  }
}`,
		description: '派生原生 Wretch client，同时继承宿主的 origin、并发、超时和生命周期策略。',
		href: '/docs/plugins/wretch',
		label: 'HTTP',
		packageName: '@pluxel/wretch',
		status: '公开安装',
	},
	{
		code: `export class Badge extends BasePlugin {
  constructor(
    private canvas: CanvasPlugin,
  ) { super() }

  render() {
    const surface = this.canvas.createCanvas(640, 320)
    const ctx = surface.getContext('2d')
    ctx.fillText('Pluxel', 48, 180)
    return surface.encode('png')
  }
}`,
		description: '使用原生 Canvas API 绘图，由宿主在分配前检查尺寸、像素和 native memory 预算。',
		href: '/docs/plugins/rendering/canvas',
		label: 'Canvas',
		packageName: '@pluxel/canvas',
		status: '公开安装',
	},
	{
		code: `export class Reports extends BasePlugin {
  constructor(
    private charts: EChartsPlugin,
  ) { super() }

  async renderSales() {
    return this.charts.render({
      width: 1200,
      height: 630,
      option: salesChart,
    })
  }
}`,
		description: '在受控 Worker 中完成 ECharts 布局、绘制和编码，直接得到 PNG、JPEG 或 WebP。',
		href: '/docs/plugins/rendering/echarts',
		label: 'ECharts',
		packageName: '@pluxel/echarts',
		status: '公开安装',
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
		<div className="pluxel-runtime-window" aria-label="官方 Plugin 使用示例">
		<div className="pluxel-showcase-tabs" role="tablist" aria-label="选择 Plugin 示例">
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
