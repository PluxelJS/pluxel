import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChainedCommands, Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, PluginKey, Selection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'

export function selectedTable(selection: Selection) {
	if (selection instanceof NodeSelection && selection.node.type.name === 'table')
		return { node: selection.node, position: selection.from }
	for (let depth = selection.$from.depth; depth > 0; depth--) {
		const node = selection.$from.node(depth)
		if (node.type.name !== 'table') continue
		const position = selection.$from.before(depth)
		if (selection.to < position + node.nodeSize) return { node, position }
	}
	return undefined
}

export function tableActions(withHeaderRow: boolean) {
	const actions: { label: string; command(chain: ChainedCommands): ChainedCommands }[] = [
		{ label: '增加行', command: (chain) => chain.addRowAfter() },
		{ label: '在上方插入行', command: (chain) => chain.addRowBefore() },
		{ label: '增加列', command: (chain) => chain.addColumnAfter() },
		{ label: '在左侧插入列', command: (chain) => chain.addColumnBefore() },
		{ label: '合并单元格', command: (chain) => chain.mergeCells() },
		{ label: '拆分单元格', command: (chain) => chain.splitCell() },
		...(withHeaderRow
			? [{ label: '切换表头', command: (chain: ChainedCommands) => chain.toggleHeaderRow() }]
			: []),
		{ label: '删除行', command: (chain) => chain.deleteRow() },
		{ label: '删除列', command: (chain) => chain.deleteColumn() },
		{ label: '删除表格', command: (chain) => chain.deleteTable() },
	]
	return actions
}

/** Native TableKit actions; optional properties are contributed by the caller. */
export function TableContextMenu({
	editor,
	disabled,
	withHeaderRow,
	children,
}: {
	editor: Editor
	disabled: boolean
	withHeaderRow: boolean
	children(close: () => void): ReactNode
}) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const [open, setOpen] = useState(false)
	const dialog = useRef<HTMLDivElement>(null)
	const trigger = useRef<HTMLDivElement>(null)
	const active = useRef(false)
	const focusPending = useRef(false)
	const target = useRef<{
		position: number
		element: HTMLElement
		point?: DOMRect
	} | null>(null)
	const policy = useRef({ disabled })
	policy.current = { disabled }
	const keys = useMemo(
		() => ({ menu: new PluginKey('typstTableMenu'), trigger: new PluginKey('typstTableTrigger') }),
		[editor],
	)
	const canEdit = useCallback(
		() =>
			!editor.isDestroyed &&
			!policy.current.disabled &&
			editor.isEditable &&
			!editor.view.composing,
		[editor],
	)
	const canOpen = useCallback(() => !editor.isDestroyed && !editor.view.composing, [editor])
	const close = useCallback(
		(restoreFocus = false) => {
			if (!active.current) return
			active.current = false
			focusPending.current = false
			target.current = null
			setOpen(false)
			if (!editor.isDestroyed) {
				editor.view.dispatch(editor.state.tr.setMeta(keys.menu, 'hide'))
				if (restoreFocus) editor.view.focus()
			}
		},
		[editor, keys],
	)
	const openAt = useCallback(
		(element?: HTMLElement, point?: DOMRect) => {
			if (!canOpen()) return
			const table = selectedTable(editor.state.selection)
			if (!table) return
			const nodeDOM = editor.view.nodeDOM(table.position)
			if (!(nodeDOM instanceof HTMLElement)) return
			target.current = { position: table.position, element: element ?? nodeDOM, point }
			active.current = true
			focusPending.current = true
			setOpen(true)
			// Official show meta attaches the element; updatePosition then measures it.
			editor.view.dispatch(editor.state.tr.setMeta(keys.trigger, 'hide').setMeta(keys.menu, 'show'))
			editor.view.dispatch(editor.state.tr.setMeta(keys.menu, 'updatePosition'))
		},
		[canOpen, editor, keys],
	)
	const shouldShow = useCallback(
		() =>
			active.current &&
			canOpen() &&
			selectedTable(editor.state.selection)?.position === target.current?.position,
		[canOpen, editor],
	)
	const showTrigger = useCallback(() => {
		const document = editor.view.dom.ownerDocument
		return (
			!active.current &&
			canOpen() &&
			Boolean(selectedTable(editor.state.selection)) &&
			(editor.view.hasFocus() || Boolean(trigger.current?.contains(document.activeElement)))
		)
	}, [canOpen, editor])
	const reference = useCallback(() => {
		const current = target.current
		return current
			? {
					contextElement: current.element,
					getBoundingClientRect: () => current.point ?? current.element.getBoundingClientRect(),
				}
			: null
	}, [])
	const triggerReference = useCallback(() => {
		const table = selectedTable(editor.state.selection)
		const element = table && editor.view.nodeDOM(table.position)
		return element instanceof HTMLElement
			? {
					contextElement: element,
					getBoundingClientRect: () => element.getBoundingClientRect(),
				}
			: null
	}, [editor])
	const appendTo = useCallback(() => editor.view.dom.ownerDocument.body, [editor])
	const options = useMemo(
		() => ({
			strategy: 'fixed' as const,
			placement: 'bottom-start' as const,
			offset: 6,
			flip: { padding: 8 },
			shift: { padding: 8, crossAxis: true },
			onUpdate: () => {
				if (!focusPending.current || !active.current) return
				focusPending.current = false
				const first = dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
				;(first ?? dialog.current)?.focus({ preventScroll: true })
			},
			onHide: () => {
				if (!active.current) return
				active.current = false
				focusPending.current = false
				target.current = null
				setOpen(false)
			},
		}),
		[],
	)
	const triggerOptions = useMemo(
		() => ({
			strategy: 'fixed' as const,
			placement: 'top-end' as const,
			offset: 3,
			flip: { padding: 8 },
			shift: { padding: 8, crossAxis: true },
			hide: true,
		}),
		[],
	)
	useEffect(() => {
		if (disabled) close()
	}, [disabled, close])
	useEffect(() => {
		const dom = editor.view.dom
		const document = dom.ownerDocument
		const window = document.defaultView!
		function hitTable(event: MouseEvent) {
			const element = event.target instanceof Element ? event.target.closest('table') : null
			if (!(element instanceof HTMLElement) || !dom.contains(element)) return
			const $position = editor.state.doc.resolve(editor.view.posAtDOM(element, 0))
			for (let depth = $position.depth; depth > 0; depth--)
				if ($position.node(depth).type.name === 'table')
					return { element, position: $position.before(depth) }
			return undefined
		}
		function contextmenu(event: MouseEvent) {
			if (!canOpen()) return
			const hit = hitTable(event)
			if (!hit) return
			event.preventDefault()
			const selection = editor.state.selection
			const current = selectedTable(selection)
			const cell = event.target instanceof Element ? event.target.closest('td,th') : null
			let preserve = current?.position === hit.position && selection instanceof NodeSelection
			if (current?.position === hit.position && selection instanceof CellSelection && cell) {
				selection.forEachCell((_node, position) => {
					if (editor.view.nodeDOM(position) === cell) preserve = true
				})
			}
			const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
			if (
				current?.position === hit.position &&
				!selection.empty &&
				!(selection instanceof CellSelection) &&
				position !== undefined &&
				position >= selection.from &&
				position <= selection.to
			)
				preserve = true
			if (!preserve) {
				const near = Selection.near(editor.state.doc.resolve(position ?? hit.position + 1))
				const next =
					selectedTable(near)?.position === hit.position
						? near
						: Selection.near(editor.state.doc.resolve(hit.position + 1))
				editor.view.dispatch(editor.state.tr.setSelection(next))
			}
			openAt(hit.element, new DOMRect(event.clientX, event.clientY, 0, 0))
		}
		const mousedown = (event: MouseEvent) => {
			if (event.button === 2 && canOpen() && hitTable(event)) event.preventDefault()
		}
		const keydown = (event: KeyboardEvent) => {
			if (event.isComposing || !canOpen()) return
			if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
				if (!selectedTable(editor.state.selection)) return
				event.preventDefault()
				openAt()
			}
		}
		const outside = (event: PointerEvent) => {
			if (
				!dialog.current?.contains(event.target as Node) &&
				!trigger.current?.contains(event.target as Node)
			)
				close()
		}
		const focus = (event: FocusEvent) => {
			const node = event.target as Node
			if (
				!dom.contains(node) &&
				!dialog.current?.contains(node) &&
				!trigger.current?.contains(node)
			)
				close()
		}
		const scroll = (event: Event) => {
			if (!dialog.current?.contains(event.target as Node)) close()
		}
		const blur = () => close()
		const changed = () => {
			if (
				active.current &&
				(!canOpen() || selectedTable(editor.state.selection)?.position !== target.current?.position)
			)
				close()
		}
		dom.addEventListener('mousedown', mousedown, true)
		dom.addEventListener('contextmenu', contextmenu)
		dom.addEventListener('keydown', keydown)
		dom.addEventListener('compositionstart', blur)
		document.addEventListener('pointerdown', outside, true)
		document.addEventListener('focusin', focus)
		document.addEventListener('scroll', scroll, true)
		window.addEventListener('blur', blur)
		editor.on('transaction', changed)
		return () => {
			dom.removeEventListener('mousedown', mousedown, true)
			dom.removeEventListener('contextmenu', contextmenu)
			dom.removeEventListener('keydown', keydown)
			dom.removeEventListener('compositionstart', blur)
			document.removeEventListener('pointerdown', outside, true)
			document.removeEventListener('focusin', focus)
			document.removeEventListener('scroll', scroll, true)
			window.removeEventListener('blur', blur)
			editor.off('transaction', changed)
		}
	}, [canOpen, close, editor, openAt])
	return (
		<>
			<BubbleMenu
				ref={trigger}
				editor={editor}
				pluginKey={keys.trigger}
				appendTo={appendTo}
				updateDelay={0}
				shouldShow={showTrigger}
				getReferencedVirtualElement={triggerReference}
				options={triggerOptions}
				className="typst-table-trigger"
			>
				<button
					type="button"
					aria-label="表格操作"
					aria-haspopup="dialog"
					aria-expanded={open}
					disabled={!canOpen()}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => openAt()}
				>
					<span aria-hidden="true">⋯</span>
				</button>
			</BubbleMenu>
			<BubbleMenu
				ref={dialog}
				editor={editor}
				pluginKey={keys.menu}
				appendTo={appendTo}
				updateDelay={0}
				shouldShow={shouldShow}
				getReferencedVirtualElement={reference}
				options={options}
				className="typst-floating-menu typst-table-context"
				role="dialog"
				aria-label="表格操作"
				onKeyDown={(event) => {
					// BubbleMenu's event wrapper exposes the native receiver for keyboard getters.
					const key = event.nativeEvent.key
					if (key === 'Escape') {
						event.preventDefault()
						event.stopPropagation()
						close(true)
						return
					}
					if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key))
						return
					event.preventDefault()
					const items = [
						...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
					]
					const index = items.indexOf(
						editor.view.dom.ownerDocument.activeElement as HTMLButtonElement,
					)
					const next =
						key === 'Home'
							? 0
							: key === 'End'
								? items.length - 1
								: (index + (['ArrowUp', 'ArrowLeft'].includes(key) ? -1 : 1) + items.length) %
									items.length
					items[next]?.focus({ preventScroll: true })
				}}
			>
				<div className="typst-table-context-heading">表格操作</div>
				{children(() => close(true))}
				<div className="typst-table-actions">
					{tableActions(withHeaderRow).map((action) => (
						<button
							key={action.label}
							type="button"
							disabled={!canEdit() || !action.command(editor.can().chain()).run()}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								if (!canEdit() || !shouldShow()) return
								close(true)
								action
									.command(
										editor
											.chain()
											.focus()
											.command(({ tr }) => {
												closeHistory(tr)
												return true
											}),
									)
									.run()
							}}
						>
							{action.label}
						</button>
					))}
				</div>
			</BubbleMenu>
		</>
	)
}
