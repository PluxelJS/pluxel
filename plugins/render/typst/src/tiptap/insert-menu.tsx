import {
	Fragment,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { EditorUi, Icon, canEdit } from './editor-ui'
import {
	insertEntries,
	isInsertionBoundary,
	matchesInsertion,
	prepareInsertion,
	type InsertEntry,
	type LocalInsertionTarget,
} from './insert-commands'

function FloatingMenu({
	editor,
	reference,
	className,
	elementRef,
	onReady,
	children,
}: {
	editor: Editor
	reference(): { left: number; top: number; bottom: number }
	className: string
	elementRef?: RefObject<HTMLDivElement | null>
	onReady?(): void
	children: ReactNode
}) {
	const ownRef = useRef<HTMLDivElement>(null)
	const ref = elementRef ?? ownRef
	const [point, setPoint] = useState<{ left: number; top: number } | null>(null)
	const ready = useRef(onReady)
	ready.current = onReady
	const positioned = point !== null
	useLayoutEffect(() => {
		if (positioned) ready.current?.()
	}, [positioned])
	useLayoutEffect(() => {
		const document = editor.view.dom.ownerDocument
		const window = document.defaultView!
		function position() {
			if (!ref.current || editor.isDestroyed) return
			const target = reference()
			const { width, height } = ref.current.getBoundingClientRect()
			const left = Math.max(8, Math.min(target.left, window.innerWidth - width - 8))
			const top =
				target.bottom + height + 8 < window.innerHeight
					? target.bottom + 8
					: Math.max(8, target.top - height - 8)
			setPoint((previous) =>
				previous?.left === left && previous.top === top ? previous : { left, top },
			)
		}
		position()
		document.addEventListener('scroll', position, true)
		window.addEventListener('resize', position)
		return () => {
			document.removeEventListener('scroll', position, true)
			window.removeEventListener('resize', position)
		}
	}, [editor, reference, children, ref])
	return createPortal(
		<div
			ref={ref}
			className={`typst-floating-menu ${className}`}
			style={{
				left: point?.left ?? 0,
				top: point?.top ?? 0,
				visibility: point ? 'visible' : 'hidden',
			}}
		>
			{children}
		</div>,
		editor.view.dom.ownerDocument.body,
	)
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
		<div id={id} ref={list} role="listbox" aria-label="插入内容" className="typst-slash-list">
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
	const container = useRef<HTMLDivElement>(null)
	const popup = useRef<HTMLDivElement>(null)
	const trigger = useRef<HTMLButtonElement>(null)
	const search = useRef<HTMLInputElement>(null)
	const target = useRef<LocalInsertionTarget | undefined>(undefined)
	const openChange = useRef(onOpenChange)
	openChange.current = onOpenChange
	const enabled =
		canEdit(editor, ui) && (at === undefined || isInsertionBoundary(editor.state.doc, at))
	const visible = open && enabled && (!target.current || target.current.doc === editor.state.doc)
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
	useLayoutEffect(() => {
		if (!visible) setOpen(false)
		openChange.current?.(visible)
		return () => {
			if (visible) openChange.current?.(false)
		}
	}, [visible])
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
		setOpen(true)
	}
	return (
		<div ref={container} className={`typst-insert-menu${compact ? ' typst-insert-compact' : ''}`}>
			<button
				ref={trigger}
				type="button"
				className="typst-tool-button typst-insert-trigger"
				aria-label={compact ? '在块后插入' : '插入'}
				title={compact ? '在块后插入' : '插入内容，也可以在正文输入 /'}
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
					onReady={() => search.current?.focus({ preventScroll: true })}
					reference={() => trigger.current!.getBoundingClientRect()}
					className="typst-insert-popover"
				>
					<div id={`${id}-dialog`} role="dialog" aria-label="插入内容">
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
								if (event.key === 'Escape') {
									event.preventDefault()
									event.stopPropagation()
									setOpen(false)
									if (compact) editor.view.focus()
									else trigger.current?.focus({ preventScroll: true })
									return
								}
								if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return
								event.preventDefault()
								if (entries.length === 0) return
								if (event.key === 'Enter') select(entries[active]!)
								else
									setChoice(
										(active + (event.key === 'ArrowUp' ? -1 : 1) + entries.length) % entries.length,
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
	const visible = range && dismissed !== range.from
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
						if (!canEdit(editor, current) || event.isComposing) return false
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
