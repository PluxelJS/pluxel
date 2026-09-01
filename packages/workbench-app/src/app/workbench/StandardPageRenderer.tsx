import type {
	WorkbenchPageBlock,
	WorkbenchPageInline,
	WorkbenchPageTableAlignment,
	WorkbenchStandardPagePlanV1,
} from '@pluxel/runtime/workbench/client'
import { createElement, useId, type ReactNode } from 'react'

export function StandardPageRenderer({ plan }: { plan: WorkbenchStandardPagePlanV1 }) {
	const instanceId = useId().replaceAll(/[^A-Za-z0-9_-]/g, '')
	const anchorId = (anchor: string) => `plx-standard-page-${instanceId}-${anchor}`

	return (
		<div className="plx-standardPage">
			<article className="plx-standardPage__document">
				{plan.document.blocks.map((block, index) => renderBlock(block, index, anchorId))}
			</article>
		</div>
	)
}

function renderBlock(
	block: WorkbenchPageBlock,
	key: number,
	anchorId: (anchor: string) => string,
): ReactNode {
	switch (block.type) {
		case 'heading': {
			const id = anchorId(block.anchor)
			return createElement(
				`h${block.level}`,
				{ id, key, tabIndex: -1 },
				renderInlines(block.children, anchorId),
			)
		}
		case 'paragraph':
			return <p key={key}>{renderInlines(block.children, anchorId)}</p>
		case 'blockquote':
			return (
				<blockquote key={key}>
					{block.children.map((child, index) => renderBlock(child, index, anchorId))}
				</blockquote>
			)
		case 'list': {
			const children = block.items.map((item, itemIndex) => (
				<li key={itemIndex}>
					{item.children.map((child, childIndex) => renderBlock(child, childIndex, anchorId))}
				</li>
			))
			return block.ordered ? (
				<ol key={key} start={block.start}>
					{children}
				</ol>
			) : (
				<ul key={key}>{children}</ul>
			)
		}
		case 'thematic-break':
			return <hr key={key} />
		case 'code':
			return (
				<pre key={key}>
					<code data-language={block.language}>{block.value}</code>
				</pre>
			)
		case 'table':
			return (
				<div className="plx-standardPage__tableScroll" key={key}>
					<table>
						<thead>
							<tr>
								{block.header.map((cell, column) => (
									<th data-align={alignment(block.align[column])} key={column} scope="col">
										{renderInlines(cell, anchorId)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, column) => (
										<td data-align={alignment(block.align[column])} key={column}>
											{renderInlines(cell, anchorId)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)
		default:
			return assertNever(block)
	}
}

function renderInlines(
	inlines: readonly WorkbenchPageInline[],
	anchorId: (anchor: string) => string,
): ReactNode {
	return inlines.map((inline, index) => {
		switch (inline.type) {
			case 'text':
				return inline.value
			case 'code':
				return <code key={index}>{inline.value}</code>
			case 'emphasis':
				return <em key={index}>{renderInlines(inline.children, anchorId)}</em>
			case 'strong':
				return <strong key={index}>{renderInlines(inline.children, anchorId)}</strong>
			case 'delete':
				return <del key={index}>{renderInlines(inline.children, anchorId)}</del>
			case 'link': {
				const children = renderInlines(inline.children, anchorId)
				if (inline.target.kind === 'fragment') {
					const id = anchorId(inline.target.anchor)
					return (
						<a
							href={`#${id}`}
							key={index}
							onClick={(event) => {
								const heading = document.getElementById(id)
								if (!heading) return
								event.preventDefault()
								heading.scrollIntoView({ block: 'start' })
								heading.focus({ preventScroll: true })
							}}
						>
							{children}
						</a>
					)
				}
				if (inline.target.kind === 'https') {
					return (
						<a href={inline.target.href} key={index} rel="noreferrer noopener" target="_blank">
							{children}
						</a>
					)
				}
				return (
					<a href={inline.target.href} key={index}>
						{children}
					</a>
				)
			}
			default:
				return assertNever(inline)
		}
	})
}

function alignment(value: WorkbenchPageTableAlignment | undefined) {
	return value ?? 'default'
}

function assertNever(value: never): never {
	throw new TypeError(`[workbench-app] unsupported Standard Page node: ${String(value)}`)
}
