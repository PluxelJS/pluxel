import {
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { DragHandle } from '@tiptap/extension-drag-handle-react'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, type Transaction } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import {
	blockConversions,
	captureBlockTarget,
	prepareBlockAction,
	type BlockAction,
	type BlockConversion,
	type BlockTarget,
} from './block-actions'
import { EditorUi, allowedNode, canEdit } from './editor-ui'
import { InsertMenu } from './insert-menu'
import { editorShortcuts, matchesShortcut, shortcutProps } from './shortcuts'

const dragPosition = { placement: 'left-start', strategy: 'absolute' } as const

function blockElement(editor: Editor, target: BlockTarget) {
	if (editor.isDestroyed || editor.state.doc !== target.doc) return undefined
	const element = editor.view.nodeDOM(target.pos)
	return element instanceof HTMLElement && element.getClientRects().length > 0 ? element : undefined
}

function blockName(target: BlockTarget) {
	const type = target.node.type.name
	if (type === 'heading') return `标题 ${target.node.attrs.level}`
	return (
		blockConversions.find((item) => item.value === type)?.label ??
		({
			table: '表格',
			horizontalRule: '分隔线',
			image: '图片',
			figure: '图表与题注',
			blockMath: '独立公式',
		}[type] ||
			'内容块')
	)
}

/** Position controls beside their native block; no pointer tracking or drag implementation. */
function BlockOverlay({
	editor,
	target,
	menu = false,
	elementRef,
	onReady,
	children,
}: {
	editor: Editor
	target: BlockTarget
	menu?: boolean
	elementRef: RefObject<HTMLDivElement | null>
	onReady?(): void
	children: ReactNode
}) {
	const [point, setPoint] = useState<{ left: number; top: number } | null>(null)
	const ready = useRef(onReady)
	ready.current = onReady
	const visible = point !== null
	useLayoutEffect(() => {
		if (visible) ready.current?.()
	}, [visible])
	useLayoutEffect(() => {
		const document = editor.view.dom.ownerDocument
		const window = document.defaultView!
		const element = blockElement(editor, target)
		function position() {
			if (!elementRef.current) return
			const anchor = blockElement(editor, target)
			if (!anchor) {
				setPoint(null)
				return
			}
			const bounds = anchor.getBoundingClientRect()
			let clipTop = 0
			let clipBottom = window.innerHeight
			for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
				if (!/(auto|scroll|hidden|clip)/.test(window.getComputedStyle(parent).overflowY)) continue
				const clip = parent.getBoundingClientRect()
				clipTop = Math.max(clipTop, clip.top)
				clipBottom = Math.min(clipBottom, clip.bottom)
			}
			if (bounds.bottom <= clipTop || bounds.top >= clipBottom) {
				setPoint(null)
				return
			}
			const { width, height } = elementRef.current.getBoundingClientRect()
			const left = Math.max(
				8,
				Math.min(menu ? bounds.left : bounds.left - width - 4, window.innerWidth - width - 8),
			)
			const top = Math.max(8, clipTop, Math.min(bounds.top, window.innerHeight - height - 8))
			setPoint((previous) =>
				previous?.left === left && previous.top === top ? previous : { left, top },
			)
		}
		position()
		const observer = new ResizeObserver(position)
		observer.observe(editor.view.dom)
		if (element) observer.observe(element)
		document.addEventListener('scroll', position, true)
		window.addEventListener('resize', position)
		return () => {
			observer.disconnect()
			document.removeEventListener('scroll', position, true)
			window.removeEventListener('resize', position)
		}
	}, [editor, elementRef, menu, target])
	return createPortal(
		<div
			ref={elementRef}
			className={menu ? 'typst-floating-menu typst-block-actions-menu' : 'typst-block-current'}
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

function Grip() {
	return (
		<svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
			{[5, 10, 15].flatMap((cy) =>
				[5, 11].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.4" />),
			)}
		</svg>
	)
}

export function BlockMenu({ editor }: { editor: Editor }) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	const latest = useRef(ui)
	latest.current = ui
	const [hovered, setHovered] = useState<BlockTarget>()
	const [target, setTarget] = useState<BlockTarget>()
	const [insertion, setInsertion] = useState<BlockTarget>()
	const [focused, setFocused] = useState(false)
	const menu = useRef<HTMLDivElement>(null)
	const currentControls = useRef<HTMLDivElement>(null)
	const hoveredControls = useRef<HTMLDivElement>(null)
	const targetRef = useRef(target)
	targetRef.current = target
	const insertionRef = useRef(insertion)
	insertionRef.current = insertion
	const insertionFromCurrent = useRef(false)
	const focusControls = useRef(false)
	const enabled = canEdit(editor, ui)
	const validHover = hovered?.doc === editor.state.doc ? hovered : undefined
	const current = captureBlockTarget(editor)
	const fallback =
		!target && insertion && insertionFromCurrent.current
			? insertion
			: !validHover && focused && !target
				? current
				: undefined
	const controlsTarget = insertionFromCurrent.current ? validHover : (insertion ?? validHover)
	const hidden =
		!enabled ||
		Boolean(target) ||
		!controlsTarget ||
		Boolean(insertion && insertionFromCurrent.current)

	function close(restoreFocus = false) {
		setTarget(undefined)
		if (restoreFocus && !editor.isDestroyed) editor.view.focus()
	}
	function open(block: BlockTarget) {
		if (!canEdit(editor, latest.current) || !blockElement(editor, block)) return
		// Expose the whole block in native state before moving focus into its controls.
		editor.view.dispatch(
			editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block.pos)),
		)
		setTarget(block)
	}
	function run(action: BlockAction) {
		if (!target) return
		const transaction = prepareBlockAction(editor, ui, target, action)
		if (!transaction) return
		close()
		editor.view.dispatch(transaction)
		editor.view.focus()
	}

	useEffect(() => {
		if (!enabled) {
			setTarget(undefined)
			setInsertion(undefined)
			setHovered(undefined)
		}
	}, [enabled])
	useLayoutEffect(() => {
		if (target && menu.current?.style.visibility === 'visible')
			menu.current
				?.querySelector<HTMLElement>('select:not(:disabled), button:not(:disabled)')
				?.focus({ preventScroll: true })
	}, [target])
	useLayoutEffect(() => {
		if (
			focusControls.current &&
			fallback &&
			currentControls.current?.style.visibility === 'visible'
		) {
			currentControls.current
				.querySelector<HTMLElement>('[aria-label="当前块操作"]')
				?.focus({ preventScroll: true })
			focusControls.current = false
		}
	}, [fallback])
	useEffect(() => {
		const dom = editor.view.dom
		const document = dom.ownerDocument
		const window = document.defaultView!
		function focus() {
			const active = document.activeElement
			setFocused(
				Boolean(
					active &&
					(dom.contains(active) ||
						currentControls.current?.contains(active) ||
						hoveredControls.current?.contains(active)),
				),
			)
			if (targetRef.current && active && !menu.current?.contains(active)) close()
		}
		function outside(event: Event) {
			if (targetRef.current && !menu.current?.contains(event.target as Node)) close()
		}
		function escape(event: KeyboardEvent) {
			if (
				event.key === 'Escape' &&
				!event.isComposing &&
				targetRef.current &&
				menu.current?.contains(event.target as Node)
			) {
				event.preventDefault()
				close(true)
			}
		}
		function changed({ transaction }: { transaction: Transaction }) {
			if (transaction.docChanged) {
				setTarget(undefined)
				setInsertion(undefined)
			}
		}
		function composition() {
			setTarget(undefined)
			setInsertion(undefined)
			setHovered(undefined)
		}
		function drag(event: DragEvent) {
			const source = event.target as HTMLElement
			if (!dom.parentElement?.contains(source) || !source.closest('.typst-block-drag')) return
			// The official plugin does not guard composition; stop before its drag handler.
			if (
				!canEdit(editor, latest.current) ||
				source.closest('.typst-block-drag-hidden') ||
				targetRef.current ||
				insertionRef.current ||
				source.closest('.typst-insert-menu')
			) {
				event.preventDefault()
				event.stopImmediatePropagation()
			}
		}
		function keydown(event: KeyboardEvent) {
			if (
				!matchesShortcut(event, editorShortcuts.block) ||
				event.defaultPrevented ||
				event.isComposing ||
				(event.target as HTMLElement).closest(
					'.typst-content-block, input, textarea, select, button',
				) ||
				!canEdit(editor, latest.current) ||
				!captureBlockTarget(editor)
			)
				return
			event.preventDefault()
			setHovered(undefined)
			setFocused(true)
			const button =
				currentControls.current?.style.visibility === 'visible'
					? currentControls.current.querySelector<HTMLElement>('[aria-label="当前块操作"]')
					: null
			focusControls.current = !button
			button?.focus({ preventScroll: true })
		}
		function hiddenRegion() {
			if (dom.getClientRects().length === 0) {
				composition()
				setFocused(false)
			}
		}
		const observer = new ResizeObserver(hiddenRegion)
		observer.observe(dom)
		document.addEventListener('focusin', focus)
		document.addEventListener('pointerdown', outside, true)
		document.addEventListener('keydown', escape)
		document.addEventListener('dragstart', drag, true)
		dom.addEventListener('compositionstart', composition)
		dom.addEventListener('keydown', keydown)
		window.addEventListener('blur', composition)
		editor.on('transaction', changed)
		return () => {
			observer.disconnect()
			document.removeEventListener('focusin', focus)
			document.removeEventListener('pointerdown', outside, true)
			document.removeEventListener('keydown', escape)
			document.removeEventListener('dragstart', drag, true)
			dom.removeEventListener('compositionstart', composition)
			dom.removeEventListener('keydown', keydown)
			window.removeEventListener('blur', composition)
			editor.off('transaction', changed)
		}
	}, [editor])

	function controls(block: BlockTarget, currentBlock: boolean) {
		return (
			<div className="typst-block-controls" ref={currentBlock ? undefined : hoveredControls}>
				<InsertMenu
					editor={editor}
					at={block.pos + block.node.nodeSize}
					compact
					onOpenChange={(isOpen) => {
						if (isOpen) {
							insertionFromCurrent.current = currentBlock
							insertionRef.current = block
							setInsertion(block)
						} else if (insertionRef.current) {
							insertionFromCurrent.current = false
							insertionRef.current = undefined
							setInsertion(undefined)
							setHovered(undefined)
						}
					}}
				/>
				<button
					type="button"
					className="typst-tool-button typst-block-grip"
					aria-label={currentBlock ? '当前块操作' : '块操作'}
					{...shortcutProps(
						`${blockName(block)}：${currentBlock ? '当前块操作' : '操作或拖动'}`,
						currentBlock ? editorShortcuts.block : undefined,
					)}
					aria-haspopup="dialog"
					onClick={() => open(block)}
				>
					<Grip />
				</button>
			</div>
		)
	}

	const conversion =
		target?.node.type.name === 'heading'
			? `heading-${target.node.attrs.level}`
			: target?.node.type.name
	return (
		<>
			<DragHandle
				editor={editor}
				nested={false}
				computePositionConfig={dragPosition}
				onElementDragStart={() => editor.view.dispatch(closeHistory(editor.state.tr))}
				className={`typst-block-drag${hidden ? ' typst-block-drag-hidden' : ''}`}
				getReferencedVirtualElement={() => {
					const locked = insertionRef.current
					const element = locked && blockElement(editor, locked)
					return element ? { getBoundingClientRect: () => element.getBoundingClientRect() } : null
				}}
				onNodeChange={({ node, pos }) => {
					setHovered(
						node && canEdit(editor, latest.current) ? captureBlockTarget(editor, pos) : undefined,
					)
				}}
			>
				{controlsTarget && controls(controlsTarget, false)}
			</DragHandle>
			{enabled && fallback && (
				<BlockOverlay
					editor={editor}
					target={fallback}
					elementRef={currentControls}
					onReady={() => {
						if (!focusControls.current) return
						currentControls.current
							?.querySelector<HTMLElement>('[aria-label="当前块操作"]')
							?.focus({ preventScroll: true })
						focusControls.current = false
					}}
				>
					{controls(fallback, true)}
				</BlockOverlay>
			)}
			{enabled && target && (
				<BlockOverlay
					editor={editor}
					target={target}
					menu
					elementRef={menu}
					onReady={() => {
						menu.current
							?.querySelector<HTMLElement>('select:not(:disabled), button:not(:disabled)')
							?.focus({ preventScroll: true })
					}}
				>
					<div role="dialog" tabIndex={-1} aria-label="块操作">
						<div className="typst-block-menu-heading">{blockName(target)}</div>
						{target.node.textContent && (
							<div className="typst-block-preview">{target.node.textContent}</div>
						)}
						<label className="typst-block-conversion">
							<span>转换为</span>
							<select
								aria-label="块类型"
								value={conversion}
								onChange={(event) =>
									run({ type: 'convert', block: event.currentTarget.value as BlockConversion })
								}
							>
								{!blockConversions.some((item) => item.value === conversion) && (
									<option value={conversion}>{blockName(target)}</option>
								)}
								{blockConversions
									.filter((item) => allowedNode(ui, editor, item.node))
									.map((item) => (
										<option
											key={item.value}
											value={item.value}
											disabled={
												item.value !== conversion &&
												!prepareBlockAction(editor, ui, target, {
													type: 'convert',
													block: item.value,
												})
											}
										>
											{item.label}
										</option>
									))}
							</select>
						</label>
						<div role="group" aria-label="块操作" className="typst-block-actions">
							{(
								[
									['duplicate', '复制块'],
									['moveUp', '上移块'],
									['moveDown', '下移块'],
									['delete', '删除块'],
								] as const
							).map(([action, label]) => (
								<button
									key={action}
									type="button"
									className={action === 'delete' ? 'typst-block-delete' : undefined}
									disabled={!prepareBlockAction(editor, ui, target, action)}
									onClick={() => run(action)}
								>
									{label}
								</button>
							))}
						</div>
					</div>
				</BlockOverlay>
			)}
		</>
	)
}
