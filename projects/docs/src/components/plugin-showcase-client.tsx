'use client'

import { Link } from 'fumapress/client'
import { ArrowRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'

export interface ShowcaseExample {
	description: string
	highlighted: ReactNode
	href: string
	label: string
	packageName: string
	status: string
}

export function PluginShowcaseClient({ examples }: { examples: ShowcaseExample[] }) {
	const [activeIndex, setActiveIndex] = useState(0)
	const active = examples[activeIndex] ?? examples[0]

	function moveTab(index: number, target: EventTarget & HTMLButtonElement) {
		const nextIndex = (index + examples.length) % examples.length
		setActiveIndex(nextIndex)
		const nextTab = target.parentElement?.children[nextIndex]
		if (nextTab instanceof HTMLButtonElement) nextTab.focus()
	}

	if (!active) return null

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
			<div
				id="pluxel-plugin-example"
				className="pluxel-code"
				role="tabpanel"
				aria-labelledby={`pluxel-plugin-tab-${activeIndex}`}
			>
				{active.highlighted}
			</div>
			<div className="pluxel-showcase-footer">
				<p>{active.description}</p>
				<Link href={active.href}>
					查看文档 <ArrowRight aria-hidden="true" />
				</Link>
			</div>
		</div>
	)
}
