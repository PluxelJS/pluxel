import { useContext, useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { closeHistory } from '@tiptap/pm/history'
import type { Editor } from '@tiptap/core'
import { NodeViewWrapper, useEditorState, type NodeViewProps } from '@tiptap/react'
import { blockAttributeError, templateDefinitions } from './blocks'
import { EditorUi } from './ui'
import { FieldData } from './data-context'

/** Consumer toolbar slot; only explicitly installed nodes appear. */
export function TypstBlockPicker({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const templates = templateDefinitions(editor.extensionManager.extensions)
	const allowed = (name: string) =>
		!!editor.schema.nodes[name] && (!ui.region?.nodes || ui.region.nodes.includes(name))
	if ((!allowed('templateBlock') || templates.length === 0) && !allowed('typstSource')) return null
	return (
		<select
			className="typst-select"
			aria-label="插入模板内容"
			value=""
			disabled={!(ui.config ? ui.editable : editor.isEditable) || ui.composing}
			onChange={(event) => {
				const value = event.currentTarget.value
				const definition = templates.find((item) => `template:${item.id}` === value)
				const content = definition
					? {
							type: 'templateBlock',
							attrs: {
								id: crypto.randomUUID(),
								template: definition.id,
								props: structuredClone(definition.defaults ?? {}),
								dataPath: [],
							},
						}
					: {
							type: 'typstSource',
							attrs: { id: crypto.randomUUID(), source: '#text(fill: blue)[补充说明]' },
						}
				editor
					.chain()
					.focus()
					.command(({ tr }) => {
						closeHistory(tr)
						return true
					})
					.insertContent(content)
					.run()
			}}
		>
			<option value="" disabled>
				模板内容
			</option>
			{allowed('templateBlock') &&
				templates.map((item) => (
					<option key={item.id} value={`template:${item.id}`}>
						{item.label}
					</option>
				))}
			{allowed('typstSource') && <option value="source">Typst 源码块</option>}
		</select>
	)
}

/** Atomic content uses native selection, drag/drop and commands; only source editing is local. */
export function TypstBlockView({ editor, node, selected, getPos }: NodeViewProps) {
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const { data } = useContext(FieldData)
	const menuId = useId()
	const menu = useRef<HTMLDivElement>(null)
	const menuTrigger = useRef<HTMLButtonElement>(null)
	const pointer = useRef<{ x: number; y: number } | null>(null)
	const source = node.type.name === 'typstSource'
	const definition = templateDefinitions(editor.extensionManager.extensions).find(
		(item) => item.id === node.attrs.template,
	)
	const stored = (node.attrs.source ?? '') as string
	const [text, setText] = useState(stored)
	const [error, setError] = useState('')
	const settings = useRef<HTMLDetailsElement>(null)
	const sourceInput = useRef<HTMLTextAreaElement>(null)
	useEffect(() => {
		const navigate = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => {
			const target = transaction.getMeta('typst-navigation')
			if (
				!source ||
				!target ||
				typeof target !== 'object' ||
				transaction.selection.from !== getPos()
			)
				return
			if (settings.current) settings.current.open = true
			requestAnimationFrame(() => {
				if (!sourceInput.current) return
				if (text !== stored) {
					setError('存在未应用修改，请应用后再定位源码。')
					sourceInput.current.focus()
					return
				}
				setError('')
				const lines = stored.split('\n')
				const offset =
					lines
						.slice(0, target.line - 1)
						.reduce((sum: number, line: string) => sum + line.length + 1, 0) +
					target.column -
					1
				sourceInput.current.focus()
				sourceInput.current.setSelectionRange(offset, offset)
			})
		}
		editor.on('transaction', navigate)
		return () => {
			editor.off('transaction', navigate)
		}
	}, [editor, source, stored, text, getPos])

	useEffect(() => {
		setText(stored)
		setError('')
	}, [stored])
	const readOnly = !(ui.config ? ui.editable : editor.isEditable)
	const disabled = readOnly || ui.composing
	function reveal() {
		const at = getPos()
		if (typeof at !== 'number') return
		editor.chain().setNodeSelection(at).focus().run()
		ui.onReveal?.(at)
	}
	function openMenu(x: number, y: number) {
		if (disabled || !menu.current) return
		const at = getPos()
		if (typeof at !== 'number') return
		editor.commands.setNodeSelection(at)
		menu.current.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 168))}px`
		menu.current.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 90))}px`
		menu.current.showPopover()
		// The native context event restores editor focus after its handlers finish.
		requestAnimationFrame(() => {
			if (menu.current?.matches(':popover-open'))
				menu.current.querySelector('button')?.focus({ preventScroll: true })
		})
	}
	useEffect(() => {
		if (disabled || !selected) menu.current?.hidePopover()
	}, [disabled, selected])
	function change(action: 'copy' | 'delete' | 'apply') {
		const at = getPos()
		if (disabled || typeof at !== 'number') return
		const current = editor.state.doc.nodeAt(at)
		if (!current || current.attrs.id !== node.attrs.id) return
		if (action === 'apply') {
			const problem = blockAttributeError(
				current.type.name,
				{ ...current.attrs, source: text },
				editor.extensionManager.extensions,
			)
			if (problem) {
				setError(problem)
				return
			}
		}
		menu.current?.hidePopover()
		const chain = editor
			.chain()
			.focus()
			.command(({ tr }) => {
				closeHistory(tr)
				return true
			})
		if (action === 'copy') {
			const next = at + current.nodeSize
			chain
				.insertContentAt(next, {
					...current.toJSON(),
					attrs: { ...current.attrs, id: crypto.randomUUID() },
				})
				.setNodeSelection(next)
				.run()
		} else if (action === 'delete') chain.setNodeSelection(at).deleteSelection().run()
		else chain.setNodeSelection(at).updateAttributes(current.type.name, { source: text }).run()
		setError('')
	}
	let bound = data
	for (const part of (node.attrs.dataPath ?? []) as string[])
		bound =
			bound !== null && typeof bound === 'object' && Object.hasOwn(bound, part)
				? (bound as Record<string, unknown>)[part]
				: undefined
	const label = source ? 'Typst 源码块' : (definition?.label ?? node.attrs.template)
	return (
		<NodeViewWrapper
			className="typst-content-block"
			contentEditable={false}
			data-selected={selected || undefined}
			data-block-id={node.attrs.id}
			tabIndex={0}
			onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => {
				pointer.current = { x: event.clientX, y: event.clientY }
			}}
			onClick={(event: React.MouseEvent<HTMLDivElement>) => {
				if (
					event.ctrlKey ||
					event.metaKey ||
					event.altKey ||
					event.shiftKey ||
					(event.target as HTMLElement).closest(
						'button, input, textarea, select, summary, pre, [role="menu"]',
					) ||
					(pointer.current &&
						Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 4)
				)
					return
				reveal()
			}}
			onContextMenu={(event: React.MouseEvent<HTMLDivElement>) => {
				if (disabled || (event.target as HTMLElement).closest('textarea, input, pre')) return
				event.preventDefault()
				event.stopPropagation()
				openMenu(event.clientX, event.clientY)
			}}
			onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
				if (event.target !== event.currentTarget) return
				if (event.key === 'Enter') {
					event.preventDefault()
					reveal()
				}
				if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
					event.preventDefault()
					const box = event.currentTarget.getBoundingClientRect()
					openMenu(box.left, box.top)
				}
			}}
			onDragStartCapture={(event: DragEvent<HTMLDivElement>) => {
				if (disabled) event.preventDefault()
			}}
		>
			<div className="typst-content-block-header">
				<span className="typst-block-title" data-drag-handle={disabled ? undefined : true}>
					<span className="typst-block-grip" aria-hidden="true">
						⠿
					</span>
					<strong>{label}</strong>
				</span>
				<button
					ref={menuTrigger}
					type="button"
					className="typst-block-menu-trigger"
					aria-label="块操作"
					aria-haspopup="menu"
					popoverTarget={menuId}
					disabled={disabled}
					onClick={(event) => {
						event.preventDefault()
						if (menu.current?.matches(':popover-open')) {
							menu.current.hidePopover()
							return
						}
						const box = event.currentTarget.getBoundingClientRect()
						openMenu(box.right - 160, box.bottom + 4)
					}}
				>
					⋯
				</button>
			</div>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				role="menu"
				tabIndex={-1}
				aria-label="块操作"
				className="typst-block-menu"
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault()
						event.stopPropagation()
						menu.current?.hidePopover()
						menuTrigger.current?.focus()
					} else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
						event.preventDefault()
						const items = [...event.currentTarget.querySelectorAll('button')]
						const index = items.indexOf(document.activeElement as HTMLButtonElement)
						items[
							event.key === 'Home'
								? 0
								: event.key === 'End'
									? items.length - 1
									: (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
						]?.focus()
					}
				}}
			>
				<button type="button" role="menuitem" disabled={disabled} onClick={() => change('copy')}>
					复制一份
				</button>
				<button type="button" role="menuitem" disabled={disabled} onClick={() => change('delete')}>
					删除
				</button>
			</div>
			<details ref={settings} className="typst-block-settings">
				<summary>{source ? '编辑 Typst 源码' : '参数与数据'}</summary>
				{source ? (
					<>
						<textarea
							ref={sourceInput}
							aria-label="组件 Typst 源码"
							value={text}
							readOnly={readOnly}
							onChange={(event) => setText(event.currentTarget.value)}
							spellCheck={false}
						/>
						<button
							type="button"
							disabled={disabled || text === stored}
							onClick={() => change('apply')}
						>
							应用组件修改
						</button>
						{error && (
							<p role="alert" className="typst-block-error">
								{error}
							</p>
						)}
					</>
				) : (
					<dl className="typst-block-data">
						<dt>参数</dt>
						<dd>
							<pre aria-label="组件参数">{JSON.stringify(node.attrs.props, null, 2)}</pre>
						</dd>
						<dt>
							数据 · {node.attrs.dataPath.length > 0 ? node.attrs.dataPath.join(' / ') : '完整输入'}
						</dt>
						<dd>
							<pre aria-label="组件数据">
								{bound === undefined ? '暂无数据' : JSON.stringify(bound, null, 2)}
							</pre>
						</dd>
					</dl>
				)}
			</details>
		</NodeViewWrapper>
	)
}
