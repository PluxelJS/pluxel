import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { CommandManager, posToDOMRect, type ChainedCommands, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { validateTypstRegions } from './validation'
import { TypographyTools } from './typography'
import { TypstTableStyleControls } from './table-style-controls'
import { TableContextMenu, tableActions, selectedTable } from './table-menu'
import type { TypstDataField, TypstEditorConfig, TypstRegionDefinition } from './types'

/** Compose native commands without calling run(); the editor commits one checked transaction. */
export interface TypstSlashCommand {
	id: string
	title: string
	description?: string
	keywords?: readonly string[]
	command(chain: ChainedCommands): ChainedCommands
}

interface EditorUiContext {
	onReveal?: (position: number) => void
	config?: TypstEditorConfig
	region?: TypstRegionDefinition
	composing: boolean
	editable: boolean
}

export const EditorUi = createContext<EditorUiContext>({ composing: false, editable: true })

type IconName =
	| 'bold'
	| 'italic'
	| 'underline'
	| 'strike'
	| 'code'
	| 'bullet'
	| 'ordered'
	| 'undo'
	| 'redo'
	| 'table'
	| 'field'
	| 'chevron'
	| 'text'
	| 'heading'
	| 'quote'
	| 'plus'

const paths: Record<IconName, string> = {
	bold: 'M6 4h6a4 4 0 0 1 0 8H6m6 0h1a4 4 0 0 1 0 8H6V4',
	italic: 'M19 4h-9m4 16H5M15 4 9 20',
	underline: 'M6 4v7a6 6 0 0 0 12 0V4M4 21h16',
	strike: 'M17 5c-1-1-3-2-5-2-3 0-5 2-5 4s2 3 5 4m-8 1h16m-3 3c0 3-2 5-5 5-2 0-4-1-5-2',
	code: 'm8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16',
	bullet: 'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01',
	ordered: 'M10 6h11M10 12h11M10 18h11M3 4h1v4M3 11c2-2 3 0 1 2l-1 1h3M3 17h2l-1 1c3 0 2 3-1 2',
	undo: 'M3 9h10a6 6 0 0 1 0 12H9M3 9l5-5M3 9l5 5',
	redo: 'M21 9H11a6 6 0 0 0 0 12h4m6-12-5-5m5 5-5 5',
	table: 'M3 4h18v16H3V4Zm0 5h18M9 9v11m6-11v11',
	field: 'M8 4H5v16h3m8-16h3v16h-3M10 9l4 6m0-6-4 6',
	chevron: 'm8 10 4 4 4-4',
	text: 'M4 5h16M12 5v15M8 20h8',
	heading: 'M5 4v16M19 4v16M5 12h14',
	quote: 'M10 5H4v7h6V5Zm0 7c0 4-2 6-5 7m15-14h-6v7h6V5Zm0 7c0 4-2 6-5 7',
	plus: 'M12 4v16M4 12h16',
}

function Icon({ name }: { name: IconName }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} />
		</svg>
	)
}

function allowedNode(ui: EditorUiContext, editor: Editor, ...names: string[]) {
	return names.every(
		(name) => editor.schema.nodes[name] && (!ui.region?.nodes || ui.region.nodes.includes(name)),
	)
}

function allowedMark(ui: EditorUiContext, editor: Editor, name: string) {
	return Boolean(editor.schema.marks[name]) && (!ui.region?.marks || ui.region.marks.includes(name))
}

function canEdit(editor: Editor, ui: EditorUiContext) {
	return ui.editable && editor.isEditable && !ui.composing && !editor.view.composing
}

export function allowedFields(
	ui: EditorUiContext,
	editor: Editor,
	fields: readonly TypstDataField[],
) {
	if (!allowedNode(ui, editor, 'dataField')) return []
	return fields.filter(
		(field) =>
			!ui.region?.fields ||
			ui.region.fields.some((path) => JSON.stringify(path) === JSON.stringify(field.path)),
	)
}

function ToolButton({
	label,
	icon,
	active,
	disabled,
	onClick,
}: {
	label: string
	icon: IconName
	active?: boolean
	disabled?: boolean
	onClick(): void
}) {
	return (
		<button
			type="button"
			className="typst-tool-button"
			aria-label={label}
			title={label}
			aria-pressed={active}
			disabled={disabled}
			onMouseDown={(event) => event.preventDefault()}
			onClick={onClick}
		>
			<Icon name={icon} />
		</button>
	)
}

function editChain(editor: Editor) {
	return editor
		.chain()
		.focus()
		.command(({ tr }) => {
			closeHistory(tr)
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

function MarkTools({ editor, onSelect }: { editor: Editor; onSelect?: () => void }) {
	const ui = useContext(EditorUi)
	return (
		<>
			{marks
				.filter((mark) => allowedMark(ui, editor, mark.name))
				.map((mark) => (
					<ToolButton
						key={mark.name}
						label={mark.label}
						icon={mark.icon}
						active={editor.isActive(mark.name)}
						disabled={!canEdit(editor, ui) || !mark.command(editor.can().chain()).run()}
						onClick={() => {
							mark.command(editChain(editor)).run()
							onSelect?.()
						}}
					/>
				))}
		</>
	)
}

type BlockType = 'paragraph' | 'blockquote' | 'codeBlock' | `heading-${1 | 2 | 3 | 4 | 5 | 6}`
const blocks: { value: BlockType; label: string; node: string }[] = [
	{ value: 'paragraph', label: '正文', node: 'paragraph' },
	...[1, 2, 3, 4, 5, 6].map((level) => ({
		value: `heading-${level}` as BlockType,
		label: `标题 ${level}`,
		node: 'heading',
	})),
	{ value: 'blockquote', label: '引用', node: 'blockquote' },
	{ value: 'codeBlock', label: '代码块', node: 'codeBlock' },
]

function convertBlock(editor: Editor, chain: ChainedCommands, type: BlockType): ChainedCommands {
	if (editor.isActive('blockquote')) chain = chain.lift('blockquote')
	if (editor.isActive('codeBlock')) chain = chain.setParagraph()
	if (type.startsWith('heading-'))
		return chain.setHeading({ level: Number(type.slice(-1)) as 1 | 2 | 3 | 4 | 5 | 6 })
	if (type === 'blockquote') return chain.setParagraph().wrapIn('blockquote')
	if (type === 'codeBlock') return chain.setCodeBlock()
	return chain.setParagraph()
}

function BlockPicker({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	const options = blocks.filter((block) => allowedNode(ui, editor, block.node))
	const value = editor.isActive('codeBlock')
		? 'codeBlock'
		: editor.isActive('blockquote')
			? 'blockquote'
			: editor.isActive('heading')
				? `heading-${editor.getAttributes('heading').level}`
				: 'paragraph'
	return (
		<label className="typst-block-picker" title="段落样式">
			<select
				aria-label="段落样式"
				value={value}
				disabled={!canEdit(editor, ui)}
				onChange={(event) =>
					convertBlock(editor, editChain(editor), event.currentTarget.value as BlockType).run()
				}
			>
				{options.map((block) => (
					<option
						key={block.value}
						value={block.value}
						disabled={!convertBlock(editor, editor.can().chain(), block.value).run()}
					>
						{block.label}
					</option>
				))}
			</select>
			<Icon name="chevron" />
		</label>
	)
}

function TableMenu({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	const [open, setOpen] = useState(false)
	const container = useRef<HTMLDivElement>(null)
	const trigger = useRef<HTMLButtonElement>(null)
	const id = useId()
	const inside = editor.isActive('table')
	const withHeaderRow = allowedNode(ui, editor, 'tableHeader')
	const actions: { label: string; command(chain: ChainedCommands): ChainedCommands }[] = inside
		? tableActions(withHeaderRow)
		: [
				{
					label: '插入表格',
					command: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow }),
				},
			]
	useEffect(() => {
		if (!open) return
		const document = editor.view.dom.ownerDocument
		const outside = (event: PointerEvent) => {
			if (!container.current?.contains(event.target as Node)) setOpen(false)
		}
		document.addEventListener('pointerdown', outside)
		return () => document.removeEventListener('pointerdown', outside)
	}, [editor, open])
	useLayoutEffect(() => {
		if (!open) return
		container.current
			?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
			?.focus({ preventScroll: true })
		const menu = container.current?.querySelector<HTMLElement>('.typst-dropdown')
		if (menu)
			menu.style.left = `${Math.min(0, editor.view.dom.ownerDocument.defaultView!.innerWidth - menu.getBoundingClientRect().right - 8)}px`
	}, [open])
	if (!allowedNode(ui, editor, 'table', 'tableRow', 'tableCell', 'paragraph')) return null
	return (
		<div ref={container} className="typst-command-menu" role="group" aria-label="表格命令">
			<button
				ref={trigger}
				type="button"
				className="typst-tool-button"
				aria-label="表格"
				title="表格"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				disabled={!canEdit(editor, ui)}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => setOpen(!open)}
				onKeyDown={(event) => {
					if (event.key === 'ArrowDown') {
						event.preventDefault()
						setOpen(true)
					}
				}}
			>
				<Icon name="table" />
				<Icon name="chevron" />
			</button>
			{open && (
				<div
					id={id}
					role="menu"
					tabIndex={-1}
					aria-label="表格操作"
					className="typst-dropdown"
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault()
							setOpen(false)
							trigger.current?.focus()
						}
						if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
						event.preventDefault()
						const items = [
							...(container.current?.querySelectorAll<HTMLButtonElement>(
								'[role="menuitem"]:not(:disabled)',
							) ?? []),
						]
						const index = items.indexOf(
							editor.view.dom.ownerDocument.activeElement as HTMLButtonElement,
						)
						const next =
							event.key === 'Home'
								? 0
								: event.key === 'End'
									? items.length - 1
									: (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
						items[next]?.focus()
					}}
				>
					{actions.map((action) => (
						<button
							key={action.label}
							type="button"
							role="menuitem"
							disabled={!canEdit(editor, ui) || !action.command(editor.can().chain()).run()}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								action.command(editChain(editor)).run()
								setOpen(false)
							}}
						>
							{action.label}
						</button>
					))}
				</div>
			)}
		</div>
	)
}

const noFontFamilies: readonly string[] = []

export function TypstEditorToolbar({
	editor,
	children,
	fontFamilies = noFontFamilies,
}: {
	editor: Editor
	children?: ReactNode
	/** Font families prepared by the host for Typst output; this component does not load fonts. */
	fontFamilies?: readonly string[]
}) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	return (
		<div className="typst-toolbars">
			<div role="toolbar" aria-label="正文格式" className="typst-toolbar">
				<div className="typst-tool-group">
					<ToolButton
						label="撤销"
						icon="undo"
						disabled={!canEdit(editor, ui) || !editor.can().undo()}
						onClick={() => editor.chain().focus().undo().run()}
					/>
					<ToolButton
						label="重做"
						icon="redo"
						disabled={!canEdit(editor, ui) || !editor.can().redo()}
						onClick={() => editor.chain().focus().redo().run()}
					/>
				</div>
				<div className="typst-tool-group">
					<BlockPicker editor={editor} />
				</div>
				<div className="typst-tool-group">
					<MarkTools editor={editor} />
				</div>
				<div className="typst-tool-group">
					{allowedNode(ui, editor, 'bulletList', 'listItem', 'paragraph') && (
						<ToolButton
							label="列表"
							icon="bullet"
							active={editor.isActive('bulletList')}
							disabled={!canEdit(editor, ui) || !editor.can().toggleBulletList()}
							onClick={() => editChain(editor).toggleBulletList().run()}
						/>
					)}
					{allowedNode(ui, editor, 'orderedList', 'listItem', 'paragraph') && (
						<ToolButton
							label="有序列表"
							icon="ordered"
							active={editor.isActive('orderedList')}
							disabled={!canEdit(editor, ui) || !editor.can().toggleOrderedList()}
							onClick={() => editChain(editor).toggleOrderedList().run()}
						/>
					)}
					<TableMenu editor={editor} />
				</div>
				{children && <div className="typst-tool-group typst-tool-group-custom">{children}</div>}
			</div>
			{allowedMark(ui, editor, 'textStyle') && (
				<TypographyTools
					editor={editor}
					disabled={!canEdit(editor, ui)}
					fontFamilies={fontFamilies}
					chain={() => editChain(editor)}
				/>
			)}
		</div>
	)
}

export function TypstFieldPicker({
	editor,
	fields,
}: {
	editor: Editor
	fields: readonly TypstDataField[]
}) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	const available = allowedFields(ui, editor, fields)
	if (available.length === 0) return null
	return (
		<label className="typst-field-picker" title="插入数据字段">
			<Icon name="field" />
			<select
				aria-label="插入数据字段"
				value=""
				disabled={
					!canEdit(editor, ui) ||
					!editor.can().insertContent({ type: 'dataField', attrs: { path: available[0]!.path } })
				}
				onChange={(event) => {
					const field = available.find(
						(item) => JSON.stringify(item.path) === event.currentTarget.value,
					)
					if (field)
						editChain(editor)
							.insertContent({ type: 'dataField', attrs: { path: [...field.path] } })
							.run()
				}}
			>
				<option value="">数据字段</option>
				{available.map((field) => (
					<option key={JSON.stringify(field.path)} value={JSON.stringify(field.path)}>
						{field.label}
					</option>
				))}
			</select>
			<Icon name="chevron" />
		</label>
	)
}

function FloatingMenu({
	editor,
	range,
	placement,
	className,
	children,
}: {
	editor: Editor
	range: { from: number; to: number }
	placement: 'above' | 'below'
	className: string
	children: ReactNode
}) {
	const ref = useRef<HTMLDivElement>(null)
	const [point, setPoint] = useState<{ left: number; top: number } | null>(null)
	useLayoutEffect(() => {
		const document = editor.view.dom.ownerDocument
		const window = document.defaultView!
		function position() {
			if (!ref.current || editor.isDestroyed) return
			const start = editor.view.coordsAtPos(range.from)
			const end = editor.view.coordsAtPos(range.to)
			const { width, height } = ref.current.getBoundingClientRect()
			const left = Math.max(8, Math.min(start.left, window.innerWidth - width - 8))
			const top =
				placement === 'above' && start.top > height + 12
					? start.top - height - 8
					: end.bottom + height + 8 < window.innerHeight
						? end.bottom + 8
						: Math.max(8, start.top - height - 8)
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
	}, [editor, range.from, range.to, placement, children])
	return (
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
		</div>
	)
}

/** Explicit context actions reuse the official selection menu without automatic popups. */
function TextContextMenu({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	const latest = useRef(ui)
	latest.current = ui
	const element = useRef<HTMLDivElement>(null)
	const active = useRef(false)
	const focusPending = useRef(false)
	const point = useRef<DOMRect | null>(null)
	const target = useRef<Editor['state']['selection'] | null>(null)
	const pluginKey = useMemo(() => new PluginKey('typstTextContextMenu'), [editor])
	const canOpen = useCallback(
		() =>
			canEdit(editor, latest.current) &&
			marks.some((mark) => allowedMark(latest.current, editor, mark.name)) &&
			editor.state.selection instanceof TextSelection &&
			!selectedTable(editor.state.selection) &&
			editor.view.dom.getClientRects().length > 0,
		[editor],
	)
	const shouldShow = useCallback(() => active.current && canOpen(), [canOpen])
	const appendTo = useCallback(() => editor.view.dom.ownerDocument.body, [editor])
	const reference = useCallback(
		() => ({
			contextElement: editor.view.dom,
			getBoundingClientRect: () =>
				point.current ??
				posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
		}),
		[editor],
	)
	const options = useMemo(
		() => ({
			strategy: 'fixed' as const,
			placement: 'top' as const,
			offset: 8,
			flip: { padding: 8 },
			shift: { padding: 8 },
			onUpdate: () => {
				if (!active.current || !focusPending.current) return
				focusPending.current = false
				element.current
					?.querySelector<HTMLButtonElement>('button:not(:disabled)')
					?.focus({ preventScroll: true })
			},
			onHide: () => {
				active.current = false
				focusPending.current = false
			},
		}),
		[],
	)
	const close = useCallback(
		(restoreFocus = false) => {
			if (!active.current || editor.isDestroyed) return
			active.current = false
			focusPending.current = false
			point.current = null
			target.current = null
			editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'hide'))
			if (restoreFocus) editor.view.focus()
		},
		[editor, pluginKey],
	)
	const open = useCallback(
		(at?: DOMRect) => {
			if (!canOpen()) return
			active.current = true
			focusPending.current = true
			point.current = at ?? null
			target.current = editor.state.selection
			editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'show'))
			editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'updatePosition'))
		},
		[canOpen, editor, pluginKey],
	)
	useEffect(() => {
		if (!canEdit(editor, ui)) close()
	}, [editor, ui, close])
	useEffect(() => {
		const dom = editor.view.dom
		const document = dom.ownerDocument
		const window = document.defaultView!
		const isTextTarget = (event: Event) =>
			event.target instanceof Element &&
			!event.target.closest('table, .typst-content-block, input, textarea, select')
		const mousedown = (event: MouseEvent) => {
			// Preserve a text range until the context event decides whether the click is inside it.
			if (event.button === 2 && isTextTarget(event) && canEdit(editor, latest.current))
				event.preventDefault()
		}
		const contextmenu = (event: MouseEvent) => {
			if (!isTextTarget(event) || !canEdit(editor, latest.current)) return
			const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
			if (position === undefined) return
			const selection = editor.state.selection
			if (
				!(selection instanceof TextSelection) ||
				selection.empty ||
				position < selection.from ||
				position > selection.to
			)
				editor.view.dispatch(
					editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position))),
				)
			if (!canOpen()) return
			event.preventDefault()
			open(new DOMRect(event.clientX, event.clientY, 0, 0))
		}
		const keydown = (event: KeyboardEvent) => {
			if (event.isComposing || !isTextTarget(event) || !canOpen()) return
			if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
				event.preventDefault()
				open()
			}
		}
		const outside = (event: PointerEvent) => {
			if (!element.current?.contains(event.target as Node)) close()
		}
		const focus = (event: FocusEvent) => {
			if (!dom.contains(event.target as Node) && !element.current?.contains(event.target as Node))
				close()
		}
		const scroll = (event: Event) => {
			if (!element.current?.contains(event.target as Node)) close()
		}
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && active.current) {
				event.preventDefault()
				close(true)
			}
		}
		const blur = () => close()
		const changed = () => {
			if (active.current && (!canOpen() || !target.current?.eq(editor.state.selection))) close()
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
	}, [canOpen, close, editor, open])
	return (
		<BubbleMenu
			ref={element}
			editor={editor}
			pluginKey={pluginKey}
			appendTo={appendTo}
			updateDelay={0}
			shouldShow={shouldShow}
			getReferencedVirtualElement={reference}
			options={options}
			className="typst-floating-menu typst-bubble"
			onKeyDown={(event) => {
				const key = event.nativeEvent.key
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return
				event.preventDefault()
				const items = [
					...(element.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
				]
				const index = items.indexOf(
					editor.view.dom.ownerDocument.activeElement as HTMLButtonElement,
				)
				items[
					key === 'Home'
						? 0
						: key === 'End'
							? items.length - 1
							: (index + (key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length
				]?.focus()
			}}
		>
			<div role="toolbar" aria-label="选区格式">
				<MarkTools editor={editor} onSelect={() => close(true)} />
			</div>
		</BubbleMenu>
	)
}

interface SlashEntry extends TypstSlashCommand {
	icon: IconName
}

function slashEntries(
	editor: Editor,
	ui: EditorUiContext,
	custom: readonly TypstSlashCommand[],
): SlashEntry[] {
	const entries: SlashEntry[] = []
	for (const block of blocks) {
		if (!allowedNode(ui, editor, block.node)) continue
		const heading = block.value.startsWith('heading-')
		entries.push({
			id: block.value,
			title: block.label,
			description: heading
				? `${block.value.slice(-1)} 级标题`
				: block.value === 'paragraph'
					? '普通正文段落'
					: block.value === 'blockquote'
						? '突出引用内容'
						: '保留空格与换行',
			keywords: heading
				? ['heading', 'title', `h${block.value.slice(-1)}`, '标题']
				: [block.value, '段落'],
			icon: heading
				? 'heading'
				: block.value === 'blockquote'
					? 'quote'
					: block.value === 'codeBlock'
						? 'code'
						: 'text',
			command: (chain) => convertBlock(editor, chain, block.value),
		})
	}
	if (allowedNode(ui, editor, 'bulletList', 'listItem', 'paragraph'))
		entries.push({
			id: 'bulletList',
			title: '无序列表',
			description: '用项目符号组织内容',
			keywords: ['bullet', 'list', '列表'],
			icon: 'bullet',
			command: (chain) => chain.toggleBulletList(),
		})
	if (allowedNode(ui, editor, 'orderedList', 'listItem', 'paragraph'))
		entries.push({
			id: 'orderedList',
			title: '有序列表',
			description: '用编号组织步骤',
			keywords: ['ordered', 'number', 'list', '列表'],
			icon: 'ordered',
			command: (chain) => chain.toggleOrderedList(),
		})
	if (
		allowedNode(ui, editor, 'table', 'tableRow', 'tableCell', 'paragraph') &&
		!editor.isActive('table')
	)
		entries.push({
			id: 'table',
			title: '表格',
			description: '插入 3 × 3 表格',
			keywords: ['table'],
			icon: 'table',
			command: (chain) =>
				chain.insertTable({
					rows: 3,
					cols: 3,
					withHeaderRow: allowedNode(ui, editor, 'tableHeader'),
				}),
		})
	for (const field of allowedFields(ui, editor, ui.config?.fields ?? []))
		entries.push({
			id: `field:${JSON.stringify(field.path)}`,
			title: field.label,
			description: `数据字段 · ${field.path.join(' / ')}`,
			keywords: ['field', '字段', ...field.path],
			icon: 'field',
			command: (chain) =>
				chain.insertContent({ type: 'dataField', attrs: { path: [...field.path] } }),
		})
	for (const item of custom) entries.push({ ...item, id: `custom:${item.id}`, icon: 'plus' })
	return entries
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

/** Prepare with native commands against a borrowed state; neither dispatch nor admission callbacks run. */
function insertion(
	editor: Editor,
	ui: EditorUiContext,
	range: { from: number; to: number },
	entry: TypstSlashCommand,
): Transaction | undefined {
	if (!canEdit(editor, ui)) return undefined
	let transaction: Transaction | undefined
	const manager = new CommandManager({ editor, state: editor.state })
	const chain = manager
		.chain()
		.command(({ tr }) => {
			closeHistory(tr)
			return true
		})
		.deleteRange(range)
	const success = entry
		.command(chain)
		.command(({ tr }) => {
			transaction = tr
			return true
		})
		.run()
	if (!success || !transaction) return undefined
	if (
		ui.config &&
		ui.region &&
		!validateTypstRegions({
			regions: { [ui.region.id]: transaction.doc.toJSON() },
			config: ui.config,
		}).ok
	)
		return undefined
	return transaction.scrollIntoView()
}

function SlashMenu({
	editor,
	commands,
}: {
	editor: Editor
	commands: readonly TypstSlashCommand[]
}) {
	const ui = useContext(EditorUi)
	const id = useId()
	const [choice, setChoice] = useState({ key: '', index: 0 })
	const [dismissed, setDismissed] = useState<number | null>(null)
	const dismissedRef = useRef<number | null>(null)
	const latest = useRef({ ui, commands })
	latest.current = { ui, commands }
	const choiceRef = useRef(choice)
	choiceRef.current = choice
	const range = canEdit(editor, ui) ? slashRange(editor) : undefined
	const key = range ? `${range.from}:${range.query}` : ''
	const entries = useMemo(() => {
		if (!range) return []
		const query = range.query.toLocaleLowerCase()
		return slashEntries(editor, ui, commands).filter(
			(entry) =>
				[entry.title, ...(entry.keywords ?? [])].some((term) =>
					term.toLocaleLowerCase().includes(query),
				) && insertion(editor, ui, range, entry),
		)
	}, [editor, editor.state, ui, commands, key])
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
						if (!canEdit(editor, current.ui) || event.isComposing) return false
						const target = slashRange(editor)
						if (!target || dismissedRef.current === target.from) return false
						if (event.key === 'Escape') {
							dismissedRef.current = target.from
							setDismissed(target.from)
							return true
						}
						if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return false
						const query = target.query.toLocaleLowerCase()
						const items = slashEntries(editor, current.ui, current.commands).filter(
							(entry) =>
								[entry.title, ...(entry.keywords ?? [])].some((term) =>
									term.toLocaleLowerCase().includes(query),
								) && insertion(editor, current.ui, target, entry),
						)
						if (items.length === 0) return event.key !== 'Enter'
						const currentKey = `${target.from}:${target.query}`
						const index =
							choiceRef.current.key === currentKey
								? Math.min(choiceRef.current.index, items.length - 1)
								: 0
						if (event.key === 'Enter') {
							const tr = insertion(editor, current.ui, target, items[index]!)
							if (tr) editor.view.dispatch(tr)
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
	const list = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (visible)
			list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
	}, [active, key, visible])
	if (!visible) return null
	return (
		<FloatingMenu editor={editor} range={range} placement="below" className="typst-slash">
			<div className="typst-slash-heading">
				插入内容 <kbd>↑ ↓</kbd>
			</div>
			<div id={id} ref={list} role="listbox" aria-label="插入内容" className="typst-slash-list">
				{entries.length === 0 ? (
					<div className="typst-slash-empty" role="status">
						没有匹配的内容
					</div>
				) : (
					entries.map((entry, index) => (
						<button
							key={entry.id}
							id={`${id}-${index}`}
							type="button"
							role="option"
							aria-label={entry.title}
							aria-selected={index === active}
							tabIndex={-1}
							onMouseDown={(event) => event.preventDefault()}
							onPointerMove={() => setChoice({ key, index })}
							onClick={() => {
								const tr = insertion(editor, ui, range, entry)
								if (tr) {
									editor.view.dispatch(tr)
									editor.view.focus()
								}
							}}
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
					))
				)}
			</div>
			<div className="typst-slash-footer">
				<span>
					<kbd>↵</kbd> 插入
				</span>
				<span>
					<kbd>esc</kbd> 关闭
				</span>
			</div>
		</FloatingMenu>
	)
}

const emptyCommands: readonly TypstSlashCommand[] = []

export function EditorMenus({
	editor,
	commands = emptyCommands,
}: {
	editor: Editor
	commands?: readonly TypstSlashCommand[]
}) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	return (
		<>
			<TextContextMenu editor={editor} />
			{allowedNode(ui, editor, 'table', 'tableRow', 'tableCell', 'paragraph') && (
				<TableContextMenu
					editor={editor}
					disabled={!canEdit(editor, ui)}
					withHeaderRow={allowedNode(ui, editor, 'tableHeader')}
				>
					{(close) => (
						<>
							{editor.state.selection instanceof TextSelection && (
								<div role="toolbar" aria-label="单元格文字格式" className="typst-context-marks">
									<MarkTools editor={editor} onSelect={close} />
								</div>
							)}
							<TypstTableStyleControls
								editor={editor}
								disabled={!canEdit(editor, ui)}
								onSelect={close}
							/>
						</>
					)}
				</TableContextMenu>
			)}
			<SlashMenu editor={editor} commands={commands} />
		</>
	)
}
