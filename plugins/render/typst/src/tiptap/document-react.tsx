import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
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
	// ProseMirror can retain a NodeView for an equal node after replacing document content.
	if (typeof at !== 'number' || !props.editor.state.doc.nodeAt(at)?.eq(props.node)) return false
	const transaction = closeHistory(props.editor.state.tr).setNodeMarkup(at, undefined, {
		...props.node.attrs,
		...attrs,
		...(attrs.label && !props.node.attrs.id ? { id: crypto.randomUUID() } : {}),
	})
	props.editor.view.dispatch(transaction)
	return props.editor.state.doc.nodeAt(at)?.eq(transaction.doc.nodeAt(at)!) ?? false
}

/** A short local edit commits once when the user leaves the field, never over a changed value. */
function useObjectAttribute(props: NodeViewProps, attribute: 'label' | 'latex') {
	const ui = useContext(EditorUi)
	const stored = String(props.node.attrs[attribute] ?? '')
	const [draft, setDraft] = useState<{ base: string; value: string } | null>(null)
	const [error, setError] = useState('')
	const composing = useRef(false)
	const dirty = draft !== null && draft.value !== stored
	const conflict = dirty && draft.base !== stored
	useEffect(() => {
		if (draft?.value === stored) {
			setDraft(null)
			setError('')
		}
	}, [draft, stored])
	const reset = () => {
		setDraft(null)
		setError('')
	}
	return {
		value: draft?.value ?? stored,
		dirty,
		error: conflict ? '此内容已在其他位置修改，请恢复后重新编辑。' : error,
		readOnly: !ui.editable || !props.editor.isEditable,
		composing,
		change(value: string) {
			setDraft(value === stored ? null : { base: draft?.base ?? stored, value })
			setError('')
		},
		reset,
		commit() {
			if (composing.current) return false
			if (!dirty) return true
			if (conflict) return false
			if (!canEdit(props.editor, ui)) {
				setError('当前不可编辑，请恢复或在允许编辑后重试。')
				return false
			}
			const problem =
				attribute === 'label'
					? labelProblem(props.editor, ui, props.node.attrs.id, draft.value)
					: ''
			if (problem) {
				setError(problem)
				return false
			}
			if (
				!updateNode(props, {
					[attribute]: attribute === 'label' ? draft.value || null : draft.value,
				})
			) {
				setError('修改未通过文档校验，请恢复后重试。')
				return false
			}
			setDraft(null)
			setError('')
			return true
		},
	}
}

/** All referenceable objects use this same nearby, nonmodal label field. */
function ReferenceLabel({ props, kind }: { props: NodeViewProps; kind: string }) {
	const field = useObjectAttribute(props, 'label')
	const errorId = useId()
	return (
		<div className="typst-object-label" contentEditable={false}>
			<label className="typst-label-field">
				<span>label</span>
				<input
					aria-label={`${kind}引用 label`}
					aria-invalid={Boolean(field.error)}
					aria-describedby={field.error ? errorId : undefined}
					value={field.value}
					placeholder="添加引用名称"
					title="Enter 或移开焦点保存，Esc 恢复"
					size={Math.min(28, Math.max(12, field.value.length))}
					readOnly={field.readOnly}
					data-typst-unapplied={field.dirty || undefined}
					spellCheck={false}
					onChange={(event) => field.change(event.currentTarget.value)}
					onCompositionStart={() => {
						field.composing.current = true
					}}
					onCompositionEnd={() => {
						field.composing.current = false
					}}
					onBlur={() => field.commit()}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return
						if (event.key === 'Enter' || event.key === 'Escape') {
							event.preventDefault()
							event.stopPropagation()
							if (event.key === 'Escape') field.reset()
							else field.commit()
						}
					}}
				/>
			</label>
			{field.error && (
				<div className="typst-object-error" id={errorId}>
					<span role="alert">{field.error}</span>
					<button
						type="button"
						onMouseDown={(event) => event.preventDefault()}
						onClick={field.reset}
					>
						恢复 label
					</button>
				</div>
			)}
		</div>
	)
}

/** Caption content stays in ProseMirror, so table editing, marks and native undo work normally. */
export function TypstFigureView(props: NodeViewProps) {
	const { editor, node, selected } = props
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const kind = node.firstChild?.type.name === 'table' ? '表' : '图'
	return (
		<NodeViewWrapper
			className="typst-figure"
			data-figure-id={node.attrs.id}
			data-selected={selected || undefined}
		>
			<NodeViewContent className="typst-figure-content" />
			<span
				className="typst-figure-kind"
				contentEditable={false}
				data-drag-handle={canEdit(editor, ui) ? true : undefined}
			>
				{kind}：
			</span>
			<ReferenceLabel props={props} kind={kind} />
		</NodeViewWrapper>
	)
}

/** Formula source opens at its own position; preview and label stay visible while editing. */
export function TypstMathView(props: NodeViewProps) {
	const { editor, node, selected } = props
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const inline = node.type.name === 'inlineMath'
	const latex = useObjectAttribute(props, 'latex')
	const [editing, setEditing] = useState(false)
	const [renderError, setRenderError] = useState('')
	const preview = useRef<HTMLSpanElement>(null)
	const trigger = useRef<HTMLButtonElement>(null)
	const input = useRef<HTMLTextAreaElement>(null)
	const finishing = useRef(false)
	const sourceId = useId()
	const errorId = useId()
	useEffect(() => {
		if (editing) input.current?.focus()
	}, [editing])
	useEffect(() => {
		if (!preview.current) return
		try {
			render(latex.value, preview.current, {
				displayMode: !inline,
				throwOnError: true,
				trust: false,
				strict: 'warn',
			})
			setRenderError('')
		} catch (cause) {
			preview.current.textContent = latex.value || '空公式'
			setRenderError(cause instanceof Error ? cause.message : String(cause))
		}
	}, [latex.value, inline])
	const finish = (discard = false) => {
		if (discard) latex.reset()
		else if (!latex.commit()) return
		finishing.current = true
		setEditing(false)
		trigger.current?.focus()
	}
	const sourceKeys = (event: KeyboardEvent<HTMLElement>) => {
		if (event.nativeEvent.isComposing || latex.composing.current) return
		if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
			event.preventDefault()
			event.stopPropagation()
			finish(event.key === 'Escape')
		}
	}

	return (
		<NodeViewWrapper
			as={inline ? 'span' : 'div'}
			className={inline ? 'typst-inline-math' : 'typst-block-math'}
			contentEditable={false}
			data-selected={selected || undefined}
			data-editing={editing || undefined}
			data-equation-id={node.attrs.id}
		>
			<button
				ref={trigger}
				type="button"
				className="typst-math-preview"
				aria-label={inline ? '编辑行内公式' : '编辑独立公式'}
				aria-expanded={editing}
				aria-controls={sourceId}
				title={renderError || latex.value}
				onClick={() => {
					const position = props.getPos()
					if (typeof position === 'number') ui.onReveal?.(position)
					finishing.current = false
					setEditing(true)
					input.current?.focus()
				}}
			>
				<span ref={preview} />
				{renderError && <span className="typst-math-error">公式预览错误</span>}
			</button>
			{editing && (
				<span
					id={sourceId}
					className="typst-math-source"
					onBlur={(event) => {
						if (finishing.current) return
						if (event.currentTarget.contains(event.relatedTarget)) return
						if (latex.commit()) setEditing(false)
					}}
				>
					<label>
						<span>LaTeX</span>
						<textarea
							ref={input}
							aria-label="公式 LaTeX"
							onKeyDown={sourceKeys}
							aria-invalid={Boolean(latex.error)}
							aria-describedby={latex.error ? errorId : undefined}
							value={latex.value}
							rows={inline ? 2 : 3}
							readOnly={latex.readOnly}
							spellCheck={false}
							data-typst-unapplied={latex.dirty || undefined}
							onChange={(event) => latex.change(event.currentTarget.value)}
							onCompositionStart={() => {
								latex.composing.current = true
							}}
							onCompositionEnd={() => {
								latex.composing.current = false
							}}
						/>
					</label>
					<span className="typst-math-source-actions">
						<small>移开焦点保存 · Esc 取消</small>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => finish(true)}
							onKeyDown={sourceKeys}
						>
							取消
						</button>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => finish()}
							onKeyDown={sourceKeys}
						>
							完成
						</button>
					</span>
					{latex.error && (
						<span className="typst-object-error" id={errorId} role="alert">
							{latex.error}
						</span>
					)}
				</span>
			)}
			{!inline && (
				<div className="typst-object-meta" contentEditable={false}>
					<span className="typst-object-kind">公式</span>
					<ReferenceLabel props={props} kind="公式" />
				</div>
			)}
		</NodeViewWrapper>
	)
}

export function TypstReferenceView(props: NodeViewProps) {
	const { editor, node, selected } = props
	const ui = useContext(EditorUi)
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const target = targets(editor, ui.regions, ui.region?.id).find(
		(item) => item.id === node.attrs.target,
	)
	const [error, setError] = useState('')
	const caption =
		node.attrs.showCaption === true && target?.kind !== 'equation' ? target?.title : ''
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
			<button
				type="button"
				className="typst-reference-trigger"
				aria-label={target ? `引用 ${target.label}` : `引用目标缺失 ${node.attrs.target}`}
				aria-expanded={Boolean(selected)}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					const position = props.getPos()
					if (typeof position === 'number') {
						editor.chain().focus().setNodeSelection(position).run()
						ui.onReveal?.(position)
					}
				}}
			>
				{target
					? `@${target.label}${caption ? `「${caption}」` : ''}`
					: `@目标缺失：${node.attrs.target}`}
			</button>
			{selected && (
				<select
					className="typst-reference-display"
					aria-label="引用显示形式"
					value={
						node.attrs.showCaption == null
							? 'template'
							: node.attrs.showCaption
								? 'caption'
								: 'number'
					}
					disabled={!canEdit(editor, ui)}
					onChange={(event) => {
						if (!canEdit(editor, ui)) return
						const value = event.currentTarget.value
						setError(
							updateNode(props, { showCaption: value === 'template' ? null : value === 'caption' })
								? ''
								: '修改未通过文档校验。',
						)
					}}
				>
					<option value="template">跟随模板</option>
					<option value="number">仅编号</option>
					<option value="caption">编号与题注</option>
				</select>
			)}
			{error && (
				<span className="typst-object-error" role="alert">
					{error}
				</span>
			)}
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
