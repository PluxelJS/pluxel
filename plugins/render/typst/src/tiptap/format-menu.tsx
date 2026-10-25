import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { posToDOMRect, type ChainedCommands, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import {
	NodeSelection,
	PluginKey,
	Selection,
	TextSelection,
	type Transaction,
} from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { EditorUi, Icon, ToolButton, allowedMark, allowedNode, canEdit } from './editor-ui'
import { blockTypes, convertBlock, type BlockType } from './insert-commands'
import { ColorTools, FontTools, TypographyTools } from './typography'
import { selectionAlignment, selectionBlockType } from './selection-format'
import { TypstTableStyleControls } from './table-style-controls'
import { selectedTable, tableActions } from './table-menu'
import { LinkMenu } from './link-menu'

// Requests and format actions stay on the native editor transaction channel.
const formatRequest = new PluginKey('typstFormatRequest')
const formatAction = new PluginKey('typstFormatAction')
type FormatView = 'format' | 'link'
type FormatRequest = { point?: DOMRect; view: FormatView }

export function openFormatMenu(editor: Editor, anchor: HTMLElement) {
	editor.view.dispatch(
		editor.state.tr.setMeta(formatRequest, {
			point: anchor.getBoundingClientRect(),
			view: 'format',
		}),
	)
}

function formatChain(editor: Editor) {
	return editor.chain().command(({ tr }) => {
		closeHistory(tr)
		tr.setMeta(formatAction, true)
		return true
	})
}

const marks = [
	{
		name: 'bold',
		label: '加粗',
		icon: 'bold',
		command: (chain: ChainedCommands) => chain.toggleBold(),
	},
	{
		name: 'italic',
		label: '斜体',
		icon: 'italic',
		command: (chain: ChainedCommands) => chain.toggleItalic(),
	},
	{
		name: 'underline',
		label: '下划线',
		icon: 'underline',
		command: (chain: ChainedCommands) => chain.toggleUnderline(),
	},
	{
		name: 'strike',
		label: '删除线',
		icon: 'strike',
		command: (chain: ChainedCommands) => chain.toggleStrike(),
	},
	{
		name: 'code',
		label: '行内代码',
		icon: 'code',
		command: (chain: ChainedCommands) => chain.toggleCode(),
	},
] as const

function MarkTools({ editor, primary = false }: { editor: Editor; primary?: boolean }) {
	const ui = useContext(EditorUi)
	return (
		<>
			{marks
				.filter((mark) => !primary || ['bold', 'italic', 'underline'].includes(mark.name))
				.filter((mark) => allowedMark(ui, editor, mark.name))
				.map((mark) => (
					<ToolButton
						key={mark.name}
						label={mark.label}
						icon={mark.icon}
						active={editor.isActive(mark.name)}
						disabled={
							!canEdit(editor, ui) ||
							!hasFormatTarget(editor) ||
							!mark.command(editor.can().chain()).run()
						}
						onClick={() => {
							if (!canEdit(editor, ui) || !hasFormatTarget(editor)) return
							mark.command(formatChain(editor)).run()
							if (primary) editor.view.focus()
						}}
					/>
				))}
		</>
	)
}

function BlockPicker({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	const options = blockTypes.filter((block) => allowedNode(ui, editor, block.node))
	const value = selectionBlockType(editor)
	return (
		<label className="typst-block-picker" title="段落样式">
			<select
				aria-label="段落样式"
				value={value ?? '__mixed__'}
				disabled={!canEdit(editor, ui) || !hasFormatTarget(editor)}
				onChange={(event) => {
					if (!canEdit(editor, ui) || !hasFormatTarget(editor)) return
					convertBlock(formatChain(editor), event.currentTarget.value as BlockType).run()
				}}
			>
				{value === null && (
					<option value="__mixed__" disabled>
						混合样式
					</option>
				)}
				{options.map((block) => (
					<option
						key={block.value}
						value={block.value}
						disabled={!convertBlock(editor.can().chain(), block.value).run()}
					>
						{block.label}
					</option>
				))}
			</select>
			<Icon name="chevron" />
		</label>
	)
}

function LinkButton({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	return (
		<>
			{allowedMark(ui, editor, 'link') && (
				<button
					type="button"
					className="typst-tool-button typst-link-trigger"
					aria-label="链接"
					title="链接（Ctrl/⌘ K）"
					aria-haspopup="dialog"
					aria-pressed={editor.isActive('link')}
					disabled={!canEdit(editor, ui) || !(editor.state.selection instanceof TextSelection)}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => {
						if (canEdit(editor, ui))
							editor.view.dispatch(editor.state.tr.setMeta(formatRequest, { view: 'link' }))
					}}
				>
					<Icon name="link" />
				</button>
			)}
		</>
	)
}

function ListTools({ editor, restoreFocus = false }: { editor: Editor; restoreFocus?: boolean }) {
	const ui = useContext(EditorUi)
	return (
		<>
			{allowedNode(ui, editor, 'bulletList', 'listItem', 'paragraph') && (
				<ToolButton
					label="列表"
					icon="bullet"
					active={editor.isActive('bulletList')}
					disabled={
						!canEdit(editor, ui) || !hasFormatTarget(editor) || !editor.can().toggleBulletList()
					}
					onClick={() => {
						if (!canEdit(editor, ui) || !hasFormatTarget(editor)) return
						formatChain(editor).toggleBulletList().run()
						if (restoreFocus) editor.view.focus()
					}}
				/>
			)}
			{allowedNode(ui, editor, 'orderedList', 'listItem', 'paragraph') && (
				<ToolButton
					label="有序列表"
					icon="ordered"
					active={editor.isActive('orderedList')}
					disabled={
						!canEdit(editor, ui) || !hasFormatTarget(editor) || !editor.can().toggleOrderedList()
					}
					onClick={() => {
						if (!canEdit(editor, ui) || !hasFormatTarget(editor)) return
						formatChain(editor).toggleOrderedList().run()
						if (restoreFocus) editor.view.focus()
					}}
				/>
			)}
		</>
	)
}

function ClearFormatButton({
	editor,
	restoreFocus = false,
}: {
	editor: Editor
	restoreFocus?: boolean
}) {
	const ui = useContext(EditorUi)
	return (
		<button
			type="button"
			className="typst-tool-button typst-clear-format"
			aria-label="清除文字格式"
			title="清除文字格式（保留段落样式与对齐）"
			disabled={!canEdit(editor, ui) || !hasFormatTarget(editor) || !editor.can().unsetAllMarks()}
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => {
				if (!canEdit(editor, ui) || !hasFormatTarget(editor)) return
				formatChain(editor)
					.unsetAllMarks()
					.command(({ tr }) => {
						if (tr.selection.empty)
							tr.setStoredMarks(
								(tr.storedMarks ?? tr.selection.$from.marks()).filter((mark) =>
									editor.extensionManager.nonClearableMarks.includes(mark.type.name),
								),
							)
						return true
					})
					.run()
				if (restoreFocus) editor.view.focus()
			}}
		>
			<Icon name="clear" />
		</button>
	)
}

function AlignmentPicker({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	if (
		!['paragraph', 'heading'].some(
			(name) => allowedNode(ui, editor, name) && editor.schema.nodes[name]?.spec.attrs?.textAlign,
		)
	)
		return null
	const value = selectionAlignment(editor)
	const alignments = [
		['left', '左对齐'],
		['center', '居中'],
		['right', '右对齐'],
		['justify', '两端对齐'],
	] as const
	return (
		<label
			className="typst-type-picker typst-alignment-picker"
			title="段落对齐（Ctrl/⌘ Shift L/E/R/J）"
		>
			<select
				aria-label="段落对齐"
				value={value ?? '__mixed__'}
				disabled={
					!canEdit(editor, ui) || !hasFormatTarget(editor) || !editor.can().setTextAlign('left')
				}
				onChange={(event) => {
					if (!canEdit(editor, ui) || !hasFormatTarget(editor)) return
					const align = event.currentTarget.value
					if (align) formatChain(editor).setTextAlign(align).run()
					else formatChain(editor).unsetTextAlign().run()
				}}
			>
				{value === null && (
					<option value="__mixed__" disabled>
						混合对齐
					</option>
				)}
				<option value="">模板对齐</option>
				{alignments.map(([align, label]) => (
					<option key={align} value={align}>
						{label}
					</option>
				))}
			</select>
		</label>
	)
}

function ListIndentTools({
	editor,
	restoreFocus = false,
}: {
	editor: Editor
	restoreFocus?: boolean
}) {
	const ui = useContext(EditorUi)
	if (!editor.isActive('listItem') || !allowedNode(ui, editor, 'listItem')) return null
	return (
		<>
			<ToolButton
				label="增加缩进"
				icon="indent"
				disabled={!canEdit(editor, ui) || !editor.can().sinkListItem('listItem')}
				onClick={() => {
					if (canEdit(editor, ui)) {
						formatChain(editor).sinkListItem('listItem').run()
						if (restoreFocus) editor.view.focus()
					}
				}}
			/>
			<ToolButton
				label="减少缩进"
				icon="outdent"
				disabled={!canEdit(editor, ui) || !editor.can().liftListItem('listItem')}
				onClick={() => {
					if (canEdit(editor, ui)) {
						formatChain(editor).liftListItem('listItem').run()
						if (restoreFocus) editor.view.focus()
					}
				}}
			/>
		</>
	)
}

/** Frequent toolbar controls share menu commands, permissions and native selection. */
export function PrimaryFormatTools({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	const typography = {
		editor,
		disabled: !canEdit(editor, ui) || !hasFormatTarget(editor),
		fontFamilies: ui.fontFamilies,
		chain: () => formatChain(editor),
	}
	return (
		<>
			<div className="typst-tool-group">
				<BlockPicker editor={editor} />
			</div>
			{allowedMark(ui, editor, 'textStyle') && (
				<div className="typst-tool-group typst-toolbar-fonts">
					<FontTools {...typography} />
				</div>
			)}
			<div className="typst-tool-group">
				<MarkTools editor={editor} primary />
				{allowedMark(ui, editor, 'textStyle') && <ColorTools {...typography} compact />}
				<ClearFormatButton editor={editor} restoreFocus />
			</div>
			<div className="typst-tool-group">
				<AlignmentPicker editor={editor} />
				<ListTools editor={editor} restoreFocus />
				<ListIndentTools editor={editor} restoreFocus />
				<LinkButton editor={editor} />
			</div>
		</>
	)
}

function FormatTools({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	return (
		<div className="typst-format-tools">
			<div
				role="toolbar"
				aria-label={selectedTable(editor.state.selection) ? '单元格文字格式' : '选区格式'}
				className="typst-format-marks"
			>
				<MarkTools editor={editor} />
				<LinkButton editor={editor} />
				<ClearFormatButton editor={editor} />
			</div>
			<div role="group" aria-label="段落格式" className="typst-format-paragraph">
				<BlockPicker editor={editor} />
				<ListTools editor={editor} />
				<AlignmentPicker editor={editor} />
				<ListIndentTools editor={editor} />
			</div>
			{allowedMark(ui, editor, 'textStyle') && (
				<TypographyTools
					editor={editor}
					disabled={!canEdit(editor, ui)}
					fontFamilies={ui.fontFamilies}
					chain={() => formatChain(editor)}
				/>
			)}
		</div>
	)
}

export function hasFormatTarget(editor: Editor) {
	return (
		editor.state.selection instanceof TextSelection ||
		Boolean(selectedTable(editor.state.selection))
	)
}

/** One explicitly opened panel owns text, paragraph and table context. Selection stays native. */
export function FormatContextMenu({ editor }: { editor: Editor }) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	const latest = useRef(ui)
	latest.current = ui
	const [open, setOpen] = useState(false)
	const [view, setView] = useState<FormatView>('format')
	const dialog = useRef<HTMLDivElement>(null)
	const tableTrigger = useRef<HTMLDivElement>(null)
	const active = useRef(false)
	const focusPending = useRef(false)
	const target = useRef<{ selection: Selection; point?: DOMRect } | null>(null)
	const keys = useMemo(
		() => ({ menu: new PluginKey('typstFormatMenu'), trigger: new PluginKey('typstTableTrigger') }),
		[editor],
	)
	const canOpen = useCallback(() => {
		if (
			editor.isDestroyed ||
			editor.view.composing ||
			latest.current.composing ||
			editor.view.dom.getClientRects().length === 0
		)
			return false
		// A read-only table still exposes its current properties, with editing controls disabled.
		return (
			Boolean(selectedTable(editor.state.selection)) ||
			(canEdit(editor, latest.current) && editor.state.selection instanceof TextSelection)
		)
	}, [editor])
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
		(point?: DOMRect, nextView: FormatView = 'format') => {
			if (
				!canOpen() ||
				(nextView === 'link' &&
					(!canEdit(editor, latest.current) ||
						!allowedMark(latest.current, editor, 'link') ||
						!(editor.state.selection instanceof TextSelection)))
			)
				return
			target.current = {
				selection: editor.state.selection,
				point,
			}
			active.current = true
			focusPending.current = true
			setView(nextView)
			setOpen(true)
			editor.view.dispatch(editor.state.tr.setMeta(keys.trigger, 'hide').setMeta(keys.menu, 'show'))
			editor.view.dispatch(editor.state.tr.setMeta(keys.menu, 'updatePosition'))
		},
		[canOpen, editor, keys],
	)
	const shouldShow = useCallback(() => active.current && canOpen(), [canOpen])
	const showTrigger = useCallback(() => {
		const document = editor.view.dom.ownerDocument
		return (
			!active.current &&
			canOpen() &&
			Boolean(selectedTable(editor.state.selection)) &&
			(editor.view.hasFocus() || Boolean(tableTrigger.current?.contains(document.activeElement)))
		)
	}, [canOpen, editor])
	const reference = useCallback(
		() => ({
			contextElement: editor.view.dom,
			getBoundingClientRect: () =>
				target.current?.point ??
				posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
		}),
		[editor],
	)
	const tableReference = useCallback(() => {
		const table = selectedTable(editor.state.selection)
		const element = table && editor.view.nodeDOM(table.position)
		return element instanceof HTMLElement
			? { contextElement: element, getBoundingClientRect: () => element.getBoundingClientRect() }
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
				if (!active.current || !focusPending.current) return
				focusPending.current = false
				const first = dialog.current?.querySelector<HTMLElement>(
					'.typst-link-form input:not(:disabled), .typst-format-tools button:not(:disabled), .typst-table-style-controls button:not(:disabled), .typst-table-actions button:not(:disabled)',
				)
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
		if (!canOpen()) close()
	}, [ui, canOpen, close])
	useEffect(() => {
		if (!open || !dialog.current) return
		const observer = new ResizeObserver(() => {
			if (!active.current || editor.isDestroyed) return
			if (!canOpen()) close()
			else editor.view.dispatch(editor.state.tr.setMeta(keys.menu, 'updatePosition'))
		})
		observer.observe(dialog.current)
		observer.observe(editor.view.dom)
		return () => observer.disconnect()
	}, [canOpen, close, editor, keys, open])
	useEffect(() => {
		const dom = editor.view.dom
		const document = dom.ownerDocument
		const window = document.defaultView!
		const nativeInput = (event: Event) =>
			event.target instanceof Element &&
			Boolean(event.target.closest('.typst-content-block, input, textarea, select'))
		const hitTable = (event: MouseEvent) => {
			const element = event.target instanceof Element ? event.target.closest('table') : null
			if (!(element instanceof HTMLElement) || !dom.contains(element)) return undefined
			const $position = editor.state.doc.resolve(editor.view.posAtDOM(element, 0))
			for (let depth = $position.depth; depth > 0; depth--)
				if ($position.node(depth).type.name === 'table')
					return { element, position: $position.before(depth) }
			return undefined
		}
		const mousedown = (event: MouseEvent) => {
			if (
				event.button === 2 &&
				!editor.view.composing &&
				!latest.current.composing &&
				!nativeInput(event) &&
				(canEdit(editor, latest.current) || hitTable(event))
			)
				event.preventDefault()
		}
		const contextmenu = (event: MouseEvent) => {
			if (nativeInput(event) || editor.view.composing || latest.current.composing) return
			const hit = hitTable(event)
			if (!hit && !canEdit(editor, latest.current)) return
			const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
			if (position === undefined) return
			const selection = editor.state.selection
			let preserve =
				selection instanceof TextSelection &&
				!selection.empty &&
				position >= selection.from &&
				position <= selection.to
			if (hit && selectedTable(selection)?.position === hit.position) {
				if (selection instanceof NodeSelection) preserve = true
				if (selection instanceof CellSelection) {
					const cell = event.target instanceof Element ? event.target.closest('td, th') : null
					selection.forEachCell((_node, at) => {
						if (editor.view.nodeDOM(at) === cell) preserve = true
					})
				}
			}
			if (!preserve) {
				const near = Selection.near(editor.state.doc.resolve(position))
				editor.view.dispatch(
					editor.state.tr.setSelection(
						hit && selectedTable(near)?.position !== hit.position
							? Selection.near(editor.state.doc.resolve(hit.position + 1))
							: near,
					),
				)
			}
			if (!canOpen()) return
			event.preventDefault()
			openAt(new DOMRect(event.clientX, event.clientY, 0, 0))
		}
		const keydown = (event: KeyboardEvent) => {
			if (event.isComposing || nativeInput(event) || !canOpen()) return
			if (
				(event.metaKey || event.ctrlKey) &&
				!event.altKey &&
				!event.shiftKey &&
				event.key.toLowerCase() === 'k' &&
				canEdit(editor, latest.current) &&
				allowedMark(latest.current, editor, 'link') &&
				editor.state.selection instanceof TextSelection
			) {
				event.preventDefault()
				openAt(undefined, 'link')
			} else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
				event.preventDefault()
				openAt()
			}
		}
		const outside = (event: PointerEvent) => {
			if (
				!dialog.current?.contains(event.target as Node) &&
				!tableTrigger.current?.contains(event.target as Node)
			)
				close()
		}
		const focus = (event: FocusEvent) => {
			const node = event.target as Node
			if (
				!dom.contains(node) &&
				!dialog.current?.contains(node) &&
				!tableTrigger.current?.contains(node)
			)
				close()
		}
		const scroll = (event: Event) => {
			if (!dialog.current?.contains(event.target as Node)) close()
		}
		const blur = () => close()
		const escape = (event: KeyboardEvent) => {
			if (
				event.key === 'Escape' &&
				!event.isComposing &&
				active.current &&
				!event.defaultPrevented
			) {
				event.preventDefault()
				close(true)
			}
		}
		const changed = ({ transaction }: { transaction: Transaction }) => {
			const request = transaction.getMeta(formatRequest) as FormatRequest | undefined
			if (request) {
				openAt(request.point, request.view)
				return
			}
			if (!active.current) return
			if (transaction.getMeta(formatAction)) {
				if (target.current) {
					target.current.selection = editor.state.selection
				}
				return
			}
			if (
				!canOpen() ||
				transaction.docChanged ||
				!target.current?.selection.eq(editor.state.selection)
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
		document.addEventListener('keydown', escape)
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
			document.removeEventListener('keydown', escape)
			window.removeEventListener('blur', blur)
			editor.off('transaction', changed)
		}
	}, [canOpen, close, editor, openAt])
	const table = selectedTable(editor.state.selection)
	return (
		<>
			<BubbleMenu
				ref={tableTrigger}
				editor={editor}
				pluginKey={keys.trigger}
				appendTo={appendTo}
				updateDelay={0}
				shouldShow={showTrigger}
				getReferencedVirtualElement={tableReference}
				options={triggerOptions}
				className="typst-table-trigger"
			>
				<button
					type="button"
					aria-label="表格操作"
					aria-haspopup="dialog"
					aria-expanded={open && Boolean(table)}
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
				className={`typst-floating-menu typst-format-context${table ? ' typst-table-context' : ''}`}
				role="dialog"
				tabIndex={-1}
				aria-label={view === 'link' ? '链接' : table ? '表格操作' : '文字格式'}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) return
					const key = event.nativeEvent.key
					if (key === 'Escape') {
						event.preventDefault()
						event.stopPropagation()
						close(true)
						return
					}
					// Native selects and text inputs keep their own arrows, Home and End.
					const current = event.target as HTMLElement
					if (
						!(current instanceof HTMLButtonElement) ||
						current.closest('[role="dialog"]') !== dialog.current ||
						!current.closest('[role="toolbar"]') ||
						!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)
					)
						return
					event.preventDefault()
					const items = [
						...current
							.closest('[role="toolbar"]')!
							.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
					]
					const index = items.indexOf(current)
					const next =
						key === 'Home'
							? 0
							: key === 'End'
								? items.length - 1
								: (index + (key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length
					items[next]?.focus({ preventScroll: true })
				}}
			>
				{open && (
					<>
						<div className="typst-format-heading">
							{view === 'link' && (
								<button
									type="button"
									aria-label="返回格式"
									onClick={() => openAt(target.current?.point)}
								>
									←
								</button>
							)}
							<span>{view === 'link' ? '链接' : table ? '表格与文字' : '文字格式'}</span>
							<button type="button" aria-label="关闭格式" onClick={() => close(true)}>
								×
							</button>
						</div>
						{view === 'link' ? (
							<LinkMenu
								editor={editor}
								onApply={(transaction) => {
									editor.view.dispatch(transaction.setMeta(formatAction, true))
									if (!editor.state.doc.eq(transaction.doc)) return false
									close(true)
									return true
								}}
							/>
						) : (
							hasFormatTarget(editor) && <FormatTools editor={editor} />
						)}
						{view === 'format' && table && (
							<>
								<TypstTableStyleControls
									editor={editor}
									disabled={!canEdit(editor, ui)}
									onSelect={() => close(true)}
								/>
								<div className="typst-table-actions" role="group" aria-label="表格结构">
									{tableActions(allowedNode(ui, editor, 'tableHeader')).map((action) => (
										<button
											type="button"
											key={action.label}
											disabled={!canEdit(editor, ui) || !action.command(editor.can().chain()).run()}
											onMouseDown={(event) => event.preventDefault()}
											onClick={() => {
												if (!canEdit(editor, ui) || !shouldShow()) return
												action.command(formatChain(editor)).run()
												close(true)
											}}
										>
											{action.label}
										</button>
									))}
								</div>
							</>
						)}
					</>
				)}
			</BubbleMenu>
		</>
	)
}
