import { useContext, useEffect, useId, useRef, useState } from 'react'
import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import { NodeViewContent, NodeViewWrapper, useEditorState, type NodeViewProps } from '@tiptap/react'
import { closeHistory } from '@tiptap/pm/history'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion, exitSuggestion, type SuggestionProps } from '@tiptap/suggestion'
import { render } from 'katex'
import { validReferenceLabel } from './document-nodes'
import { referenceTargetsInDocument } from './reference-targets'
import { EditorUi, allowedNode, canEdit, type EditorUiContext } from './editor-ui'
import type { TypstEditorConfig, TypstReferenceTarget } from './types'

const kindNames = { figure: '图', table: '表', equation: '公式' } as const
type Target = TypstReferenceTarget

const targetCache = new WeakMap<
	Editor,
	{
		doc: Editor['state']['doc']
		regions?: Record<string, JSONContent>
		regionId: string
		items: Target[]
	}
>()

function targets(editor: Editor, regions?: Record<string, JSONContent>, regionId = 'body') {
	const cached = targetCache.get(editor)
	const doc = editor.state.doc
	if (cached?.doc === doc && cached.regions === regions && cached.regionId === regionId)
		return cached.items
	const items = [...new Set([...Object.keys(regions ?? {}), regionId])].flatMap((id) =>
		referenceTargetsInDocument(
			id === regionId ? doc : editor.schema.nodeFromJSON(regions![id]!),
			id,
		),
	)
	targetCache.set(editor, { doc, regions, regionId, items })
	return items
}

function labelProblem(editor: Editor, ui: EditorUiContext, id: string, label: string) {
	if (!label) return ''
	if (!validReferenceLabel(label))
		return 'Label 最多 128 个字符，以字母或数字开头，只使用字母、数字、冒号、点、下划线或连字符。'
	if (
		targets(editor, ui.regions, ui.region?.id).some(
			(target) => target.id !== id && target.label === label,
		)
	)
		return '报告中已有相同 label，请使用另一个名称。'
	return ''
}

function updateNode(props: NodeViewProps, attrs: Record<string, unknown>) {
	const at = props.getPos()
	if (typeof at !== 'number' || props.editor.state.doc.nodeAt(at) !== props.node) return false
	const transaction = closeHistory(props.editor.state.tr).setNodeMarkup(at, undefined, {
		...props.node.attrs,
		...attrs,
		...(attrs.label && !props.node.attrs.id ? { id: crypto.randomUUID() } : {}),
	})
	props.editor.view.dispatch(transaction)
	return props.editor.state.doc.nodeAt(at)?.eq(transaction.doc.nodeAt(at)!) ?? false
}

/** Caption content stays in ProseMirror, so table editing, marks and native undo work normally. */
export function TypstFigureView(props: NodeViewProps) {
	const { editor, node, selected } = props
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const stored = (node.attrs.label ?? '') as string
	const [label, setLabel] = useState(stored)
	const [error, setError] = useState('')
	useEffect(() => {
		setLabel(stored)
		setError('')
	}, [stored])
	const kind = node.firstChild?.type.name === 'table' ? '表' : '图'
	const disabled = !canEdit(editor, ui)
	const discardLabel = () => {
		setLabel(stored)
		setError('')
	}
	return (
		<NodeViewWrapper
			className="typst-figure"
			data-figure-id={node.attrs.id}
			data-selected={selected || undefined}
		>
			<div contentEditable={false} className="typst-document-object-header">
				<span data-drag-handle={disabled ? undefined : true}>{kind}与题注</span>
				<details className="typst-object-settings">
					<summary>{stored || '设置引用 label'}</summary>
					<div className="typst-object-form">
						<label>
							引用 label
							<input
								aria-label={`${kind}引用 label`}
								value={label}
								readOnly={disabled}
								data-typst-unapplied={label !== stored || undefined}
								spellCheck={false}
								onChange={(event) => setLabel(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
									event.preventDefault()
									event.stopPropagation()
									discardLabel()
								}}
							/>
						</label>
						<small>题注在下方直接编辑；编号和题注位置由模板决定。</small>
						<div className="typst-object-form-actions">
							<button
								type="button"
								disabled={disabled || label === stored}
								onClick={() => {
									const problem = labelProblem(editor, ui, node.attrs.id, label)
									if (problem) {
										setError(problem)
										return
									}
									setError(
										updateNode(props, { label: label || null }) ? '' : '修改未通过文档校验。',
									)
								}}
							>
								应用 label
							</button>
							<button type="button" disabled={label === stored && !error} onClick={discardLabel}>
								取消修改
							</button>
						</div>
						{error && <span role="alert">{error}</span>}
					</div>
				</details>
			</div>
			<NodeViewContent className="typst-figure-content" />
		</NodeViewWrapper>
	)
}

/** Use the official math schema/commands and KaTeX rendering with an explicit draft editor. */
export function TypstMathView(props: NodeViewProps) {
	const { editor, node, selected } = props
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const inline = node.type.name === 'inlineMath'
	const storedLatex = String(node.attrs.latex ?? '')
	const storedLabel = String(node.attrs.label ?? '')
	const [latex, setLatex] = useState(storedLatex)
	const [label, setLabel] = useState(storedLabel)
	const [error, setError] = useState('')
	const [renderError, setRenderError] = useState('')
	const preview = useRef<HTMLSpanElement>(null)
	const form = useRef<HTMLSpanElement>(null)
	const input = useRef<HTMLTextAreaElement>(null)
	const formId = useId()
	const disabled = !canEdit(editor, ui)
	useEffect(() => {
		setLatex(storedLatex)
		setLabel(storedLabel)
		setError('')
	}, [storedLatex, storedLabel])
	useEffect(() => {
		if (!preview.current) return
		try {
			render(storedLatex, preview.current, {
				displayMode: !inline,
				throwOnError: true,
				trust: false,
				strict: 'warn',
			})
			setRenderError('')
		} catch (cause) {
			preview.current.textContent = storedLatex || '空公式'
			setRenderError(cause instanceof Error ? cause.message : String(cause))
		}
	}, [storedLatex, inline])
	const changed = latex !== storedLatex || (!inline && label !== storedLabel)
	return (
		<NodeViewWrapper
			as={inline ? 'span' : 'div'}
			className={inline ? 'typst-inline-math' : 'typst-block-math'}
			contentEditable={false}
			data-selected={selected || undefined}
			data-equation-id={node.attrs.id}
		>
			<button
				type="button"
				className="typst-math-preview"
				aria-label={inline ? '编辑行内公式' : '编辑独立公式'}
				title={renderError || storedLatex}
				popoverTarget={formId}
				onClick={() => requestAnimationFrame(() => input.current?.focus())}
			>
				<span ref={preview} />
				{renderError && <span className="typst-math-error">公式预览错误</span>}
			</button>
			{!inline && <span className="typst-math-label">{storedLabel || '未设置引用 label'}</span>}
			<span
				ref={form}
				id={formId}
				popover="auto"
				className="typst-math-form typst-object-form"
				aria-label="编辑公式"
			>
				<strong>{inline ? '行内公式' : '独立公式'}</strong>
				<label>
					LaTeX
					<textarea
						ref={input}
						aria-label="公式 LaTeX"
						value={latex}
						readOnly={disabled}
						spellCheck={false}
						data-typst-unapplied={changed || undefined}
						onChange={(event) => setLatex(event.currentTarget.value)}
					/>
				</label>
				{!inline && (
					<label>
						引用 label
						<input
							aria-label="公式引用 label"
							value={label}
							readOnly={disabled}
							spellCheck={false}
							onChange={(event) => setLabel(event.currentTarget.value)}
						/>
					</label>
				)}
				<small>保存同一份 LaTeX；模板通过 MiTeX 排版，独立公式编号由模板设置。</small>
				<span className="typst-object-form-actions">
					<button
						type="button"
						disabled={disabled || !changed}
						onClick={() => {
							const problem = inline ? '' : labelProblem(editor, ui, node.attrs.id, label)
							if (problem) {
								setError(problem)
								return
							}
							if (updateNode(props, { latex, ...(!inline ? { label: label || null } : {}) })) {
								setError('')
								form.current?.hidePopover()
							} else setError('修改未通过文档校验。')
						}}
					>
						应用公式
					</button>
					<button
						type="button"
						onClick={() => {
							setLatex(storedLatex)
							setLabel(storedLabel)
							setError('')
							form.current?.hidePopover()
						}}
					>
						取消修改
					</button>
				</span>
				{error && <span role="alert">{error}</span>}
			</span>
		</NodeViewWrapper>
	)
}

export function TypstReferenceView({ editor, node, selected }: NodeViewProps) {
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const target = targets(editor, ui.regions, ui.region?.id).find(
		(item) => item.id === node.attrs.target,
	)
	return (
		<NodeViewWrapper
			as="span"
			className="typst-reference"
			contentEditable={false}
			data-selected={selected || undefined}
			data-missing={!target || undefined}
			title={
				target
					? `${kindNames[target.kind]} · ${target.title} · ${target.regionId}`
					: `引用目标不存在或尚未设置 label：${node.attrs.target}`
			}
		>
			{target ? `@${target.label}` : `@目标缺失：${node.attrs.target}`}
		</NodeViewWrapper>
	)
}

/** Attach a caption to the selected image, table or atomic template/source block. */
export function TypstFigureTools({ editor }: { editor: Editor }) {
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const selection = editor.state.selection
	const at = selection.$from.depth > 0 ? selection.$from.before(1) : selection.from
	const node = editor.state.doc.nodeAt(at)
	if (
		!node ||
		!['image', 'table', 'templateBlock', 'typstSource'].includes(node.type.name) ||
		!allowedNode(ui, editor, 'figure', 'figureCaption')
	)
		return null
	return (
		<button
			type="button"
			className="typst-tool-button typst-caption-trigger"
			disabled={!canEdit(editor, ui)}
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => {
				if (canEdit(editor, ui))
					editor
						.chain()
						.focus()
						.command(({ tr }) => {
							closeHistory(tr)
							return true
						})
						.wrapTypstFigure(at)
						.run()
			}}
		>
			添加{node.type.name === 'table' ? '表题' : '图题'}
		</button>
	)
}

const referenceSuggestionKey = new PluginKey('typstReferenceSuggestion')

/** Official Suggestion owns matching and decoration; this small view owns its menu lifecycle. */
export function createReferenceSuggestion(
	latest: () => {
		regionId: string
		regions?: Record<string, JSONContent>
		config: TypstEditorConfig
		editable?: boolean
	},
) {
	return Extension.create({
		name: 'typstReferenceSuggestion',
		addProseMirrorPlugins() {
			const editor = this.editor
			return [
				Suggestion<Target>({
					editor,
					pluginKey: referenceSuggestionKey,
					char: '@',
					allowedPrefixes: null,
					allowSpaces: true,
					allow: ({ state }) => {
						const props = latest()
						const region = props.config.regions.find((item) => item.id === props.regionId)
						return (
							props.editable !== false &&
							editor.isEditable &&
							!editor.view.composing &&
							Boolean(state.schema.nodes.reference) &&
							(!region?.nodes || region.nodes.includes('reference')) &&
							!editor.isActive('codeBlock')
						)
					},
					items: ({ query }) => {
						const props = latest()
						const terms = query.trim().toLocaleLowerCase().split(/\s+/)
						return targets(editor, props.regions, props.regionId)
							.filter((target) =>
								terms.every((term) =>
									`${target.label} ${target.title} ${kindNames[target.kind]} ${target.kind} ${target.regionId}`
										.toLocaleLowerCase()
										.includes(term),
								),
							)
							.slice(0, 20)
					},
					command: ({ range, props }) => {
						if (latest().editable === false || editor.view.composing) return
						editor
							.chain()
							.focus()
							.command(({ tr }) => {
								closeHistory(tr)
								return true
							})
							.deleteRange(range)
							.insertTypstReference(props.id)
							.run()
					},
					render: () => {
						let popup: HTMLDivElement | undefined
						let selected = 0
						let current: SuggestionProps<Target> | undefined
						const outside = (event: Event) => {
							if (
								!editor.view.dom.contains(event.target as Node) &&
								!popup?.contains(event.target as Node)
							)
								exitSuggestion(editor.view, referenceSuggestionKey)
						}
						const draw = () => {
							if (!popup || !current) return
							const document = editor.view.dom.ownerDocument
							popup.replaceChildren()
							if (current.items.length === 0) {
								const empty = document.createElement('p')
								empty.textContent = '没有匹配的图、表或公式。先为对象设置 label。'
								popup.append(empty)
							}
							current.items.forEach((target, index) => {
								const button = document.createElement('button')
								button.type = 'button'
								button.setAttribute('role', 'option')
								button.setAttribute('aria-selected', String(index === selected))
								button.textContent = `${kindNames[target.kind]} · ${target.title || target.label}  @${target.label}`
								button.title = `${target.regionId} · ${target.label}`
								button.onpointerdown = (event) => event.preventDefault()
								button.onclick = () => current?.command(target)
								popup!.append(button)
							})
							const rect = current.clientRect?.()
							if (rect) {
								const window = document.defaultView!
								popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`
								popup.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - popup.offsetHeight - 8))}px`
							}
							popup.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
						}
						return {
							onStart: (props) => {
								current = props
								popup = editor.view.dom.ownerDocument.createElement('div')
								popup.className = 'typst-reference-suggestions'
								popup.setAttribute('role', 'listbox')
								popup.setAttribute('aria-label', '引用图、表或公式')
								editor.view.dom.ownerDocument.body.append(popup)
								editor.view.dom.ownerDocument.addEventListener('pointerdown', outside)
								draw()
							},
							onUpdate: (props) => {
								current = props
								selected = 0
								draw()
							},
							onKeyDown: ({ event }) => {
								if (event.isComposing || !current) return false
								if (event.key === 'Escape') {
									exitSuggestion(editor.view, referenceSuggestionKey)
									return true
								}
								if (current.items.length === 0) return false
								if (event.key === 'Enter') {
									current.command(current.items[selected]!)
									return true
								}
								if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
									selected =
										(selected + (event.key === 'ArrowUp' ? -1 : 1) + current.items.length) %
										current.items.length
									draw()
									return true
								}
								return false
							},
							onExit: () => {
								editor.view.dom.ownerDocument.removeEventListener('pointerdown', outside)
								popup?.remove()
								popup = undefined
								current = undefined
							},
						}
					},
				}),
			]
		},
	})
}
