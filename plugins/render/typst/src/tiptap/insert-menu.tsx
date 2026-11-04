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
	findPendingSourceInput,
	focusOpenSourcePanel,
	preserveSourceButtonFocus,
} from './source-controls'
import {
	insertEntries,
	isInsertionBoundary,
	canInsertEntry,
	matchesInsertion,
	prepareInsertion,
	dispatchInsertion,
	tableEntry,
	type InsertEntry,
	type LocalInsertionTarget,
	type TypstSlashCommand,
} from './insert-commands'

interface InputTarget {
	kind: 'table' | 'import' | 'include'
	doc: ProseMirrorNode
	selection: Selection
}

function hasUnappliedInput(popup: RefObject<HTMLDivElement | null>): boolean {
	return Boolean(popup.current?.querySelector('[data-typst-unapplied]'))
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
			const inside = element.contains(event.target as Node)
			if (
				event.defaultPrevented ||
				event.isComposing ||
				composing ||
				(!inside &&
					(event.key !== 'Escape' ||
						!hasUnappliedInput(popup) ||
						(event.target as Element).closest?.('[role="dialog"]')))
			)
				return
			if (event.key === 'Escape') {
				event.preventDefault()
				event.stopPropagation()
				callbacks.current.onCancel()
			} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				const form = element.querySelector('form')
				if (form) {
					event.preventDefault()
					event.stopPropagation()
					form.requestSubmit()
				}
			}
		}
		const blur = () => callbacks.current.onBlur()
		element.addEventListener('compositionstart', start)
		element.addEventListener('compositionend', end)
		element.addEventListener('mousedown', preserveSourceButtonFocus)
		document.addEventListener('keydown', keydown)
		window.addEventListener('blur', blur)
		return () => {
			element.removeEventListener('compositionstart', start)
			element.removeEventListener('compositionend', end)
			element.removeEventListener('mousedown', preserveSourceButtonFocus)
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
			<span>组件和字段最多显示 100 项，可输入文件名或完整字段路径细化搜索。</span>
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
	const [input, setInput] = useState<InputTarget>()
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
	const dirty = Boolean(input && hasUnappliedInput(popup))
	const visible =
		open &&
		!editor.isDestroyed &&
		(dirty ||
			(enabled &&
				(!target.current || target.current.doc === editor.state.doc) &&
				(!input ||
					(input.doc === editor.state.doc &&
						(Boolean(target.current) || input.selection.eq(editor.state.selection))))))
	const entries = useMemo(
		() =>
			visible
				? insertEntries(editor, ui, target.current, query).filter(
						(entry) =>
							matchesInsertion(entry, query) && canInsertEntry(editor, ui, entry, target.current),
					)
				: [],
		[editor, editor.state, ui, visible, query],
	)
	const active = Math.min(choice, entries.length - 1)
	useInsertionKeyboard({
		visible,
		popup,
		onCancel: cancel,
		onBlur: () => {
			if (!hasUnappliedInput(popup)) setOpen(false)
		},
	})
	useLayoutEffect(() => {
		if (!visible) {
			setOpen(false)
			setInput(undefined)
		}
		openChange.current?.(visible)
		return () => {
			if (visible) openChange.current?.(false)
		}
	}, [visible])
	useLayoutEffect(() => {
		if (input && popup.current?.style.visibility === 'visible')
			popup.current
				.querySelector<HTMLElement>('input:not(:disabled)')
				?.focus({ preventScroll: true })
	}, [input])
	useEffect(() => {
		if (!visible) return
		const dom = editor.view.dom
		const document = dom.ownerDocument
		const observer = new ResizeObserver(() => {
			if (!hasUnappliedInput(popup) && dom.getClientRects().length === 0) setOpen(false)
		})
		observer.observe(dom)
		const outside = (event: Event) => {
			if (
				!hasUnappliedInput(popup) &&
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
		if (entry.input || entry.id === 'table') {
			setInput({
				kind: entry.input ?? 'table',
				doc: editor.state.doc,
				selection: editor.state.selection,
			})
			return
		}
		const transaction = prepareInsertion(editor, ui, entry, target.current)
		if (!transaction) return
		if (!dispatchInsertion(editor, transaction)) return
		setOpen(false)
		editor.view.focus()
	}
	function insert(entry: TypstSlashCommand): boolean {
		if (
			!input ||
			input.doc !== editor.state.doc ||
			(!target.current && !input.selection.eq(editor.state.selection))
		)
			return false
		if (
			target.current &&
			(target.current.doc !== editor.state.doc ||
				!isInsertionBoundary(editor.state.doc, target.current.at))
		)
			return false
		// Imports belong at file scope; a block-local placeholder would add unrelated body content.
		const position = input.kind === 'import' ? undefined : target.current
		const transaction = prepareInsertion(editor, ui, entry, position)
		if (!transaction) return false
		if (!dispatchInsertion(editor, transaction)) return false
		setOpen(false)
		editor.view.focus()
		return true
	}
	function show() {
		if (!enabled || focusOpenSourcePanel(trigger.current) || hasUnappliedInput(popup)) return
		target.current = at === undefined ? undefined : { at, doc: editor.state.doc }
		setQuery('')
		setChoice(0)
		setInput(undefined)
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
				onClick={() => {
					if (!visible) show()
					else if (!hasUnappliedInput(popup)) setOpen(false)
					else focusOpenSourcePanel(trigger.current)
				}}
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
					onReady={() =>
						input
							? popup.current
									?.querySelector<HTMLElement>('input:not(:disabled)')
									?.focus({ preventScroll: true })
							: search.current?.focus({ preventScroll: true })
					}
					reference={() => trigger.current!.getBoundingClientRect()}
					className="typst-insert-popover"
				>
					<div
						id={`${id}-dialog`}
						role={input ? undefined : 'dialog'}
						aria-label={input ? undefined : '插入内容'}
					>
						{input?.kind === 'table' ? (
							<TableSizeForm
								editor={editor}
								inputRef={rows}
								onCancel={cancel}
								onInsert={(size) => {
									const entry = tableEntry(size)
									return Boolean(entry && insert(entry))
								}}
							/>
						) : input ? (
							ui.renderSourceFileInput?.(input.kind, insert, cancel)
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
	const [input, setInput] = useState<
		InputTarget & {
			range: { from: number; to: number }
			point: { left: number; top: number; bottom: number }
		}
	>()
	const inputRef = useRef(input)
	inputRef.current = input
	const popup = useRef<HTMLDivElement>(null)
	const rows = useRef<HTMLInputElement>(null)
	const [dismissed, setDismissed] = useState<number | null>(null)
	const dismissedRef = useRef<number | null>(null)
	const latest = useRef(ui)
	latest.current = ui
	const choiceRef = useRef(choice)
	choiceRef.current = choice
	const pending = findPendingSourceInput(editor.view.dom.ownerDocument)
	const range =
		canEdit(editor, ui) && (!pending || popup.current?.contains(pending))
			? slashRange(editor)
			: undefined
	const key = range ? `${range.from}:${range.query}` : ''
	const entries = useMemo(
		() =>
			range
				? insertEntries(editor, ui, undefined, range.query).filter(
						(entry) =>
							matchesInsertion(entry, range.query) && canInsertEntry(editor, ui, entry, range),
					)
				: [],
		[editor, editor.state, ui, key],
	)
	const active = Math.min(choice.key === key ? choice.index : 0, entries.length - 1)
	const visible = range && dismissed !== range.from && !input
	const inputVisible = Boolean(
		input &&
		!editor.isDestroyed &&
		(hasUnappliedInput(popup) ||
			(canEdit(editor, ui) &&
				input.doc === editor.state.doc &&
				input.selection.eq(editor.state.selection))),
	)
	function cancelInput() {
		if (!input) return
		dismissedRef.current = input.range.from
		setDismissed(input.range.from)
		setInput(undefined)
		editor.view.focus()
	}
	useInsertionKeyboard({
		visible: inputVisible,
		popup,
		onCancel: cancelInput,
		onBlur: () => {
			if (!hasUnappliedInput(popup)) setInput(undefined)
		},
	})
	function openInput(kind: InputTarget['kind'], target: { from: number; to: number }) {
		if (focusOpenSourcePanel(editor.view.dom)) return
		const start = editor.view.coordsAtPos(target.from)
		const end = editor.view.coordsAtPos(target.to)
		setInput({
			kind,
			doc: editor.state.doc,
			selection: editor.state.selection,
			range: target,
			point: { left: start.left, top: start.top, bottom: end.bottom },
		})
	}
	function insert(entry: TypstSlashCommand): boolean {
		if (!input || input.doc !== editor.state.doc || !input.selection.eq(editor.state.selection))
			return false
		const transaction = prepareInsertion(editor, ui, entry, input.range)
		if (!transaction) return false
		if (!dispatchInsertion(editor, transaction)) return false
		setInput(undefined)
		editor.view.focus()
		return true
	}
	useEffect(() => {
		if (input && !inputVisible) setInput(undefined)
	}, [input, inputVisible])
	useEffect(() => {
		if (!inputVisible) return
		const dom = editor.view.dom
		const document = dom.ownerDocument
		const outside = (event: Event) => {
			if (!hasUnappliedInput(popup) && !popup.current?.contains(event.target as Node))
				setInput(undefined)
		}
		const observer = new ResizeObserver(() => {
			if (!hasUnappliedInput(popup) && dom.getClientRects().length === 0) setInput(undefined)
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
	}, [editor, inputVisible])
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
						if (!canEdit(editor, current) || event.isComposing || inputRef.current) return false
						if (findPendingSourceInput(editor.view.dom.ownerDocument)) return false
						const target = slashRange(editor)
						if (!target || dismissedRef.current === target.from) return false
						if (event.key === 'Escape') {
							dismissedRef.current = target.from
							setDismissed(target.from)
							return true
						}
						if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return false
						const items = insertEntries(editor, current, undefined, target.query).filter(
							(entry) =>
								matchesInsertion(entry, target.query) &&
								canInsertEntry(editor, current, entry, target),
						)
						if (items.length === 0) return event.key !== 'Enter'
						const currentKey = `${target.from}:${target.query}`
						const index =
							choiceRef.current.key === currentKey
								? Math.min(choiceRef.current.index, items.length - 1)
								: 0
						if (event.key === 'Enter') {
							if (items[index]!.input || items[index]!.id === 'table') {
								openInput(items[index]!.input ?? 'table', target)
								return true
							}
							const transaction = prepareInsertion(editor, current, items[index]!, target)
							if (transaction) dispatchInsertion(editor, transaction)
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
	if (input && inputVisible)
		return (
			<FloatingMenu
				key="input"
				editor={editor}
				elementRef={popup}
				reference={() => input.point}
				className="typst-insert-popover"
				onReady={() =>
					popup.current
						?.querySelector<HTMLElement>('input:not(:disabled)')
						?.focus({ preventScroll: true })
				}
			>
				<div>
					{input.kind === 'table' ? (
						<TableSizeForm
							editor={editor}
							inputRef={rows}
							onCancel={cancelInput}
							onInsert={(size) => {
								const entry = tableEntry(size)
								return Boolean(entry && insert(entry))
							}}
						/>
					) : (
						ui.renderSourceFileInput?.(input.kind, insert, cancelInput)
					)}
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
					if (entry.input || entry.id === 'table') {
						openInput(entry.input ?? 'table', current)
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
