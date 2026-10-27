import {
	Fragment,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from 'react'
import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Selection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { EditorUi, Icon, canEdit } from './editor-ui'
import { FloatingMenu } from './floating-menu'
import { TableSizeForm } from './table-size-form'
import {
	insertEntries,
	isInsertionBoundary,
	matchesInsertion,
	prepareInsertion,
	tableEntry,
	type InsertEntry,
	type LocalInsertionTarget,
} from './insert-commands'

interface TableTarget {
	doc: ProseMirrorNode
	selection: Selection
}

/** Non-modal insertion popups leave Tab native and release themselves on window blur. */
function useInsertionKeyboard({
	visible,
	popup,
	onCancel,
	onBlur,
}: {
	visible: boolean
	popup: RefObject<HTMLDivElement | null>
	onCancel(): void
	onBlur(): void
}) {
	const callbacks = useRef({ onCancel, onBlur })
	callbacks.current = { onCancel, onBlur }
	useEffect(() => {
		const element = popup.current
		if (!visible || !element) return
		const document = element.ownerDocument
		const window = document.defaultView!
		let composing = false
		const start = () => {
			composing = true
		}
		const end = () => {
			composing = false
		}
		const keydown = (event: KeyboardEvent) => {
			if (
				event.key !== 'Escape' ||
				event.defaultPrevented ||
				event.isComposing ||
				composing ||
				!element.contains(event.target as Node)
			)
				return
			event.preventDefault()
			event.stopPropagation()
			callbacks.current.onCancel()
		}
		const blur = () => callbacks.current.onBlur()
		element.addEventListener('compositionstart', start)
		element.addEventListener('compositionend', end)
		document.addEventListener('keydown', keydown)
		window.addEventListener('blur', blur)
		return () => {
			element.removeEventListener('compositionstart', start)
			element.removeEventListener('compositionend', end)
			document.removeEventListener('keydown', keydown)
			window.removeEventListener('blur', blur)
		}
	}, [popup, visible])
}

function EntryList({
	id,
	entries,
	active,
	onChoice,
	onSelect,
}: {
	id: string
	entries: readonly InsertEntry[]
	active: number
	onChoice(index: number): void
	onSelect(entry: InsertEntry): void
}) {
	const list = useRef<HTMLDivElement>(null)
	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
	}, [active, entries])
	return (
		<div
			id={id}
			ref={list}
			role="listbox"
			tabIndex={-1}
			aria-label="插入内容"
			className="typst-slash-list"
		>
			{entries.length === 0 ? (
				<div className="typst-slash-empty" role="status">
					没有匹配的内容
				</div>
			) : (
				entries.map((entry, index) => (
					<Fragment key={entry.id}>
						{entries[index - 1]?.group !== entry.group && (
							<div className="typst-insert-group" aria-hidden="true">
								{entry.group}
							</div>
						)}
						<button
							id={`${id}-${index}`}
							type="button"
							role="option"
							aria-label={entry.title}
							aria-selected={index === active}
							tabIndex={-1}
							onMouseDown={(event) => event.preventDefault()}
							onPointerMove={() => onChoice(index)}
							onClick={() => onSelect(entry)}
						>
							<span className="typst-slash-icon">
								<Icon name={entry.icon} />
							</span>
							<span>
								<span className="typst-slash-title">{entry.title}</span>
								{entry.description && (
									<span className="typst-slash-description">{entry.description}</span>
								)}
							</span>
							{index === active && <kbd>↵</kbd>}
						</button>
					</Fragment>
				))
			)}
		</div>
	)
}

function InsertHelp() {
	return (
		<div className="typst-slash-footer">
			<span>
				<kbd>↵</kbd> 插入
			</span>
			<span>
				<kbd>esc</kbd> 关闭
			</span>
		</div>
	)
}

/** The explicit entry also works when the editor has a caret, without a text selection. */
export function InsertMenu({
	editor,
	at,
	compact = false,
	onOpenChange,
}: {
	editor: Editor
	at?: number
	compact?: boolean
	onOpenChange?(open: boolean): void
}) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	const id = useId()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [choice, setChoice] = useState(0)
	const [table, setTable] = useState<TableTarget>()
	const container = useRef<HTMLDivElement>(null)
	const popup = useRef<HTMLDivElement>(null)
	const trigger = useRef<HTMLButtonElement>(null)
	const search = useRef<HTMLInputElement>(null)
	const rows = useRef<HTMLInputElement>(null)
	const target = useRef<LocalInsertionTarget | undefined>(undefined)
	const openChange = useRef(onOpenChange)
	openChange.current = onOpenChange
	const enabled =
		canEdit(editor, ui) && (at === undefined || isInsertionBoundary(editor.state.doc, at))
	const visible =
		open &&
		enabled &&
		(!target.current || target.current.doc === editor.state.doc) &&
		(!table ||
			(table.doc === editor.state.doc &&
				(Boolean(target.current) || table.selection.eq(editor.state.selection))))
	const entries = useMemo(
		() =>
			visible
				? insertEntries(editor, ui, target.current).filter(
						(entry) =>
							matchesInsertion(entry, query) && prepareInsertion(editor, ui, entry, target.current),
					)
				: [],
		[editor, editor.state, ui, visible, query],
	)
	const active = Math.min(choice, entries.length - 1)
	useInsertionKeyboard({ visible, popup, onCancel: cancel, onBlur: () => setOpen(false) })
	useLayoutEffect(() => {
		if (!visible) {
			setOpen(false)
			setTable(undefined)
		}
		openChange.current?.(visible)
		return () => {
			if (visible) openChange.current?.(false)
		}
	}, [visible])
	useLayoutEffect(() => {
		if (table && popup.current?.style.visibility === 'visible')
			rows.current?.focus({ preventScroll: true })
	}, [table])
	useEffect(() => {
		if (!visible) return
		const dom = editor.view.dom
		const document = dom.ownerDocument
		const observer = new ResizeObserver(() => {
			if (dom.getClientRects().length === 0) setOpen(false)
		})
		observer.observe(dom)
		const outside = (event: Event) => {
			if (
				!container.current?.contains(event.target as Node) &&
				!popup.current?.contains(event.target as Node)
			)
				setOpen(false)
		}
		document.addEventListener('pointerdown', outside, true)
		document.addEventListener('focusin', outside)
		return () => {
			observer.disconnect()
			document.removeEventListener('pointerdown', outside, true)
			document.removeEventListener('focusin', outside)
		}
	}, [editor, visible])
	function select(entry: InsertEntry) {
		if (entry.id === 'table') {
			setTable({ doc: editor.state.doc, selection: editor.state.selection })
			return
		}
		const transaction = prepareInsertion(editor, ui, entry, target.current)
		if (!transaction) return
		editor.view.dispatch(transaction)
		setOpen(false)
		editor.view.focus()
	}
	function show() {
		if (!enabled) return
		target.current = at === undefined ? undefined : { at, doc: editor.state.doc }
		setQuery('')
		setChoice(0)
		setTable(undefined)
		setOpen(true)
	}
	function cancel() {
		setOpen(false)
		if (compact) editor.view.focus()
		else trigger.current?.focus({ preventScroll: true })
	}
	return (
		<div ref={container} className={`typst-insert-menu${compact ? ' typst-insert-compact' : ''}`}>
			<button
				ref={trigger}
				type="button"
				className="typst-tool-button typst-insert-trigger"
				aria-label={compact ? '在块后插入' : '插入'}
				title={compact ? '在块后插入' : '在正文输入 / 插入内容；输入 @ 引用图、表或公式'}
				aria-haspopup="dialog"
				aria-expanded={visible}
				aria-controls={visible ? `${id}-dialog` : undefined}
				disabled={!enabled}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => (visible ? setOpen(false) : show())}
				onKeyDown={(event) => {
					if (event.key === 'ArrowDown') {
						event.preventDefault()
						show()
					}
				}}
			>
				<Icon name="plus" />
				{!compact && <span>插入</span>}
			</button>
			{visible && (
				<FloatingMenu
					editor={editor}
					elementRef={popup}
					onReady={() => (table ? rows : search).current?.focus({ preventScroll: true })}
					reference={() => trigger.current!.getBoundingClientRect()}
					className="typst-insert-popover"
				>
					<div
						id={`${id}-dialog`}
						role={table ? undefined : 'dialog'}
						aria-label={table ? undefined : '插入内容'}
					>
						{table ? (
							<TableSizeForm
								editor={editor}
								inputRef={rows}
								onCancel={cancel}
								onInsert={(size) => {
									if (
										table.doc !== editor.state.doc ||
										(!target.current && !table.selection.eq(editor.state.selection))
									)
										return false
									const entry = tableEntry(size)
									const transaction = entry && prepareInsertion(editor, ui, entry, target.current)
									if (!transaction) return false
									editor.view.dispatch(transaction)
									if (!editor.state.doc.eq(transaction.doc)) return false
									setOpen(false)
									editor.view.focus()
									return true
								}}
							/>
						) : (
							<>
								<input
									ref={search}
									type="search"
									className="typst-insert-search"
									aria-label="搜索插入内容"
									aria-controls={id}
									aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
									placeholder="搜索段落、字段或组件…"
									value={query}
									onKeyDown={(event) => {
										if (event.nativeEvent.isComposing) return
										if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return
										event.preventDefault()
										if (entries.length === 0) return
										if (event.key === 'Enter') select(entries[active]!)
										else
											setChoice(
												(active + (event.key === 'ArrowUp' ? -1 : 1) + entries.length) %
													entries.length,
											)
									}}
									onChange={(event) => {
										setQuery(event.currentTarget.value)
										setChoice(0)
									}}
								/>
								<EntryList
									id={id}
									entries={entries}
									active={active}
									onChoice={setChoice}
									onSelect={select}
								/>
								<InsertHelp />
							</>
						)}
					</div>
				</FloatingMenu>
			)}
		</div>
	)
}

function slashRange(editor: Editor) {
	const { selection } = editor.state
	if (
		!editor.isFocused ||
		!selection.empty ||
		!selection.$from.parent.isTextblock ||
		selection.$from.parent.type.name === 'codeBlock'
	)
		return undefined
	const before = selection.$from.parent.textBetween(
		0,
		selection.$from.parentOffset,
		'\ufffc',
		'\ufffc',
	)
	const match = /(?:^|\s)\/([^\s/]{0,48})$/u.exec(before)
	return match
		? { from: selection.from - match[1]!.length - 1, to: selection.from, query: match[1]! }
		: undefined
}

export function SlashMenu({ editor }: { editor: Editor }) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	const id = useId()
	const [choice, setChoice] = useState({ key: '', index: 0 })
	const [table, setTable] = useState<
		TableTarget & {
			range: { from: number; to: number }
			point: { left: number; top: number; bottom: number }
		}
	>()
	const tableRef = useRef(table)
	tableRef.current = table
	const popup = useRef<HTMLDivElement>(null)
	const rows = useRef<HTMLInputElement>(null)
	const [dismissed, setDismissed] = useState<number | null>(null)
	const dismissedRef = useRef<number | null>(null)
	const latest = useRef(ui)
	latest.current = ui
	const choiceRef = useRef(choice)
	choiceRef.current = choice
	const range = canEdit(editor, ui) ? slashRange(editor) : undefined
	const key = range ? `${range.from}:${range.query}` : ''
	const entries = useMemo(
		() =>
			range
				? insertEntries(editor, ui).filter(
						(entry) =>
							matchesInsertion(entry, range.query) && prepareInsertion(editor, ui, entry, range),
					)
				: [],
		[editor, editor.state, ui, key],
	)
	const active = Math.min(choice.key === key ? choice.index : 0, entries.length - 1)
	const visible = range && dismissed !== range.from && !table
	const tableVisible = Boolean(
		table &&
		canEdit(editor, ui) &&
		table.doc === editor.state.doc &&
		table.selection.eq(editor.state.selection),
	)
	function cancelTable() {
		if (!table) return
		dismissedRef.current = table.range.from
		setDismissed(table.range.from)
		setTable(undefined)
		editor.view.focus()
	}
	useInsertionKeyboard({
		visible: tableVisible,
		popup,
		onCancel: cancelTable,
		onBlur: () => setTable(undefined),
	})
	function openTable(target: { from: number; to: number }) {
		const start = editor.view.coordsAtPos(target.from)
		const end = editor.view.coordsAtPos(target.to)
		setTable({
			doc: editor.state.doc,
			selection: editor.state.selection,
			range: target,
			point: { left: start.left, top: start.top, bottom: end.bottom },
		})
	}
	useEffect(() => {
		if (table && !tableVisible) setTable(undefined)
	}, [table, tableVisible])
	useEffect(() => {
		if (!tableVisible) return
		const dom = editor.view.dom
		const document = dom.ownerDocument
		const outside = (event: Event) => {
			if (!popup.current?.contains(event.target as Node)) setTable(undefined)
		}
		const observer = new ResizeObserver(() => {
			if (dom.getClientRects().length === 0) setTable(undefined)
		})
		observer.observe(dom)
		document.addEventListener('pointerdown', outside, true)
		document.addEventListener('focusin', outside)
		// The slash form freezes its screen anchor with the native insertion target.
		document.addEventListener('scroll', outside, true)
		return () => {
			observer.disconnect()
			document.removeEventListener('pointerdown', outside, true)
			document.removeEventListener('focusin', outside)
			document.removeEventListener('scroll', outside, true)
		}
	}, [editor, tableVisible])
	useEffect(() => {
		if (!range) {
			dismissedRef.current = null
			setDismissed(null)
		}
	}, [range?.from])
	useEffect(() => {
		const pluginKey = new PluginKey('typstSlashMenu')
		editor.registerPlugin(
			new Plugin({
				key: pluginKey,
				props: {
					handleKeyDown(_view, event) {
						const current = latest.current
						if (!canEdit(editor, current) || event.isComposing || tableRef.current) return false
						const target = slashRange(editor)
						if (!target || dismissedRef.current === target.from) return false
						if (event.key === 'Escape') {
							dismissedRef.current = target.from
							setDismissed(target.from)
							return true
						}
						if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return false
						const items = insertEntries(editor, current).filter(
							(entry) =>
								matchesInsertion(entry, target.query) &&
								prepareInsertion(editor, current, entry, target),
						)
						if (items.length === 0) return event.key !== 'Enter'
						const currentKey = `${target.from}:${target.query}`
						const index =
							choiceRef.current.key === currentKey
								? Math.min(choiceRef.current.index, items.length - 1)
								: 0
						if (event.key === 'Enter') {
							if (items[index]!.id === 'table') {
								openTable(target)
								return true
							}
							const transaction = prepareInsertion(editor, current, items[index]!, target)
							if (transaction) editor.view.dispatch(transaction)
							return true
						}
						const next = (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
						choiceRef.current = { key: currentKey, index: next }
						setChoice(choiceRef.current)
						return true
					},
				},
			}),
			(plugin, plugins) => [plugin, ...plugins],
		)
		return () => {
			if (!editor.isDestroyed) editor.unregisterPlugin(pluginKey)
		}
	}, [editor])
	useEffect(() => {
		const dom = editor.view.dom
		if (!visible) return
		dom.setAttribute('aria-controls', id)
		if (active >= 0) dom.setAttribute('aria-activedescendant', `${id}-${active}`)
		return () => {
			dom.removeAttribute('aria-controls')
			dom.removeAttribute('aria-activedescendant')
		}
	}, [editor, visible, id, active])
	if (table && tableVisible)
		return (
			<FloatingMenu
				key="table"
				editor={editor}
				elementRef={popup}
				reference={() => table.point}
				className="typst-insert-popover"
				onReady={() => rows.current?.focus({ preventScroll: true })}
			>
				<div>
					<TableSizeForm
						editor={editor}
						inputRef={rows}
						onCancel={cancelTable}
						onInsert={(size) => {
							if (table.doc !== editor.state.doc || !table.selection.eq(editor.state.selection))
								return false
							const entry = tableEntry(size)
							const transaction = entry && prepareInsertion(editor, ui, entry, table.range)
							if (!transaction) return false
							editor.view.dispatch(transaction)
							if (!editor.state.doc.eq(transaction.doc)) return false
							setTable(undefined)
							editor.view.focus()
							return true
						}}
					/>
				</div>
			</FloatingMenu>
		)
	if (!visible) return null
	return (
		<FloatingMenu
			editor={editor}
			reference={() => {
				const start = editor.view.coordsAtPos(range.from)
				const end = editor.view.coordsAtPos(range.to)
				return { left: start.left, top: start.top, bottom: end.bottom }
			}}
			className="typst-slash"
		>
			<div className="typst-slash-heading">
				插入内容 <kbd>↑ ↓</kbd>
			</div>
			<EntryList
				id={id}
				entries={entries}
				active={active}
				onChoice={(index) => setChoice({ key, index })}
				onSelect={(entry) => {
					const current = slashRange(editor)
					if (!current) return
					if (entry.id === 'table') {
						openTable(current)
						return
					}
					const transaction = prepareInsertion(editor, ui, entry, current)
					if (transaction) {
						editor.view.dispatch(transaction)
						editor.view.focus()
					}
				}}
			/>
			<InsertHelp />
		</FloatingMenu>
	)
}
