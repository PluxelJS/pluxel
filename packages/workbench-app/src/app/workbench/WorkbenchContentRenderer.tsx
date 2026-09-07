import type {
	WorkbenchContentBlock,
	WorkbenchContentInline,
	WorkbenchContentTableAlignment,
	WorkbenchContentPlan,
} from '@pluxel/runtime/workbench/client'
import { createElement, useId, useSyncExternalStore, type ReactNode } from 'react'
import type { WorkbenchContentDataState } from './WorkbenchContentController'
import { WorkbenchContentSlot, type WorkbenchContentInteraction } from './WorkbenchContentSlots'

const STATIC_STATE: WorkbenchContentDataState = Object.freeze({
	status: 'loading',
	data: null,
	stale: false,
	refreshing: false,
	message: null,
})
const STATIC_SUBSCRIBE = (): (() => void) => () => undefined
const GET_STATIC_STATE = () => STATIC_STATE

export function WorkbenchContentRenderer({
	plan,
	interaction = null,
}: {
	plan: WorkbenchContentPlan
	interaction?: WorkbenchContentInteraction | null
}) {
	const instanceId = useId().replaceAll(/[^A-Za-z0-9_-]/g, '')
	const anchorId = (anchor: string) => `plx-workbench-content-${instanceId}-${anchor}`
	const state = useSyncExternalStore(
		interaction?.controller.subscribe ?? STATIC_SUBSCRIBE,
		interaction?.controller.getSnapshot ?? GET_STATIC_STATE,
		interaction?.controller.getSnapshot ?? GET_STATIC_STATE,
	)
	const renderSlot = (slotKey: string, display: 'inline' | 'block') => (
		<WorkbenchContentSlot
			display={display}
			interaction={interaction}
			slotKey={slotKey}
			state={state}
		/>
	)

	return (
		<div className="plx-workbenchContent">
			<article className="plx-workbenchContent__document">
				{plan.document.blocks.map((block, index) =>
					renderBlock(block, index, anchorId, renderSlot),
				)}
			</article>
		</div>
	)
}

function renderBlock(
	block: WorkbenchContentBlock,
	key: number,
	anchorId: (anchor: string) => string,
	renderSlot: (slotKey: string, display: 'inline' | 'block') => ReactNode,
): ReactNode {
	switch (block.type) {
		case 'slot':
			return <div key={key}>{renderSlot(block.key, 'block')}</div>
		case 'heading': {
			const id = anchorId(block.anchor)
			return createElement(
				`h${block.level}`,
				{ id, key, tabIndex: -1 },
				renderInlines(block.children, anchorId, renderSlot),
			)
		}
		case 'paragraph':
			return <p key={key}>{renderInlines(block.children, anchorId, renderSlot)}</p>
		case 'blockquote':
			return (
				<blockquote key={key}>
					{block.children.map((child, index) => renderBlock(child, index, anchorId, renderSlot))}
				</blockquote>
			)
		case 'list': {
			const children = block.items.map((item, itemIndex) => (
				<li key={itemIndex}>
					{item.children.map((child, childIndex) =>
						renderBlock(child, childIndex, anchorId, renderSlot),
					)}
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
				<div className="plx-workbenchContent__tableScroll" key={key}>
					<table>
						<thead>
							<tr>
								{block.header.map((cell, column) => (
									<th data-align={alignment(block.align[column])} key={column} scope="col">
										{renderInlines(cell, anchorId, renderSlot)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, column) => (
										<td data-align={alignment(block.align[column])} key={column}>
											{renderInlines(cell, anchorId, renderSlot)}
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
	inlines: readonly WorkbenchContentInline[],
	anchorId: (anchor: string) => string,
	renderSlot: (slotKey: string, display: 'inline' | 'block') => ReactNode,
): ReactNode {
	return inlines.map((inline, index) => {
		switch (inline.type) {
			case 'slot':
				return <span key={index}>{renderSlot(inline.key, 'inline')}</span>
			case 'text':
				return inline.value
			case 'code':
				return <code key={index}>{inline.value}</code>
			case 'emphasis':
				return <em key={index}>{renderInlines(inline.children, anchorId, renderSlot)}</em>
			case 'strong':
				return <strong key={index}>{renderInlines(inline.children, anchorId, renderSlot)}</strong>
			case 'delete':
				return <del key={index}>{renderInlines(inline.children, anchorId, renderSlot)}</del>
			case 'link': {
				const children = renderInlines(inline.children, anchorId, renderSlot)
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

function alignment(value: WorkbenchContentTableAlignment | undefined) {
	return value ?? 'default'
}

function assertNever(value: never): never {
	throw new TypeError(`[workbench-app] unsupported Workbench Content node: ${String(value)}`)
}
