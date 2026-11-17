import { createElement, Fragment, useMemo, type ReactNode } from 'react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Definition, Nodes, Table } from 'mdast'
import type { MarketRelease } from '../market-contracts.ts'

/** Render registry/archive Markdown as React elements; package HTML is always text. */
export function Readme({ value }: Readonly<{ value: MarketRelease['readme'] }>) {
	const text = value?.text ?? ''
	const content = useMemo(() => renderMarkdown(text), [text])
	if (!value) return <p className="pm-muted">No README is available.</p>
	return (
		<div className="pm-stack">
			<div className="pm-readme">{content}</div>
			{value.truncated ? (
				<p className="pm-small pm-muted">This README was truncated by the market.</p>
			) : null}
		</div>
	)
}

function renderMarkdown(text: string): ReactNode {
	const tree = fromMarkdown(text, {
		extensions: [gfm()],
		mdastExtensions: [gfmFromMarkdown()],
	})
	const definitions = new Map<string, Definition>()
	function collect(node: Nodes): void {
		if (node.type === 'definition' && !definitions.has(node.identifier))
			definitions.set(node.identifier, node)
		if ('children' in node) node.children.forEach(collect)
	}
	collect(tree)

	function children(nodes: readonly Nodes[]): ReactNode {
		return nodes.map((node, index) => (
			<Fragment key={node.position?.start.offset ?? index}>{render(node)}</Fragment>
		))
	}
	function link(url: string | undefined, title: string | null | undefined, label: ReactNode) {
		const href = safeLink(url)
		return href ? (
			<a href={href} title={title ?? undefined} target="_blank" rel="noopener noreferrer">
				{label}
			</a>
		) : (
			label
		)
	}
	function table(node: Table) {
		const [header, ...rows] = node.children
		if (!header) return null
		return (
			<div className="pm-readme-table" role="region" aria-label="README table">
				<table>
					<thead>
						<tr>
							{header.children.map((cell, index) => (
								<th
									key={cell.position?.start.offset ?? index}
									scope="col"
									style={{ textAlign: node.align?.[index] ?? undefined }}
								>
									{children(cell.children)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rowIndex) => (
							<tr key={row.position?.start.offset ?? rowIndex}>
								{row.children.map((cell, index) => (
									<td
										key={cell.position?.start.offset ?? index}
										style={{ textAlign: node.align?.[index] ?? undefined }}
									>
										{children(cell.children)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		)
	}
	function render(node: Nodes): ReactNode {
		switch (node.type) {
			case 'text':
				return node.value
			case 'paragraph':
				return <p>{children(node.children)}</p>
			case 'heading':
				return createElement('h' + node.depth, null, children(node.children))
			case 'strong':
				return <strong>{children(node.children)}</strong>
			case 'emphasis':
				return <em>{children(node.children)}</em>
			case 'delete':
				return <del>{children(node.children)}</del>
			case 'inlineCode':
				return <code>{node.value}</code>
			case 'code':
				return (
					<pre>
						<code>{node.value}</code>
					</pre>
				)
			case 'blockquote':
				return <blockquote>{children(node.children)}</blockquote>
			case 'list':
				return node.ordered ? (
					<ol start={node.start ?? undefined}>{children(node.children)}</ol>
				) : (
					<ul>{children(node.children)}</ul>
				)
			case 'listItem':
				return (
					<li>
						{typeof node.checked === 'boolean' ? (
							<input
								className="pm-readme-check"
								type="checkbox"
								checked={node.checked}
								readOnly
								disabled
								aria-label={node.checked ? 'Completed' : 'Not completed'}
							/>
						) : null}
						{children(node.children)}
					</li>
				)
			case 'link':
				return link(node.url, node.title, children(node.children))
			case 'linkReference': {
				const definition = definitions.get(node.identifier)
				return link(definition?.url, definition?.title, children(node.children))
			}
			case 'image':
			case 'imageReference':
				return node.alt ?? ''
			case 'html':
				return <code className="pm-readme-html">{node.value}</code>
			case 'break':
				return <br />
			case 'thematicBreak':
				return <hr />
			case 'table':
				return table(node)
			case 'definition':
				return null
			case 'footnoteReference':
				return <sup>[{node.identifier}]</sup>
			case 'footnoteDefinition':
				return (
					<blockquote>
						<sup>[{node.identifier}]</sup>
						{children(node.children)}
					</blockquote>
				)
			default:
				return 'children' in node ? children(node.children) : null
		}
	}
	return children(tree.children)
}

// Relative links remain readable text: a package README must never navigate this host by accident.
function safeLink(value: string | undefined): string | undefined {
	if (!value) return undefined
	try {
		const url = new URL(value)
		if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
			return undefined
		return url.href
	} catch {
		return undefined
	}
}
