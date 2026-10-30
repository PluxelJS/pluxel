import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import {
	EditorContent,
	NodeViewWrapper,
	ReactNodeViewRenderer,
	type NodeViewProps,
} from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { Image } from '@tiptap/extension-image'
import type { TypstSourceProject } from '../source/state-types.js'
import type { TypstSourceDiagnostic } from '../source/types.js'
import {
	createTypstSourceEditor,
	prepareTypstSourceCopy,
	TypstInlineSource,
	TypstSourceBlock,
	TypstComponent,
	TypstField,
} from './source-editor.js'
import { TypstFigure, TypstBlockMath, TypstInlineMath, TypstReference } from './document-nodes.js'
import {
	TypstFigureView,
	TypstMathView,
	TypstReferenceView,
	createReferenceSuggestion,
} from './document-react.js'
import { EditorUi, type EditorUiContext } from './editor-ui.js'
import { EditorMenus, TypstEditorToolbar } from './ui.js'
import type { TypstReferenceTarget } from './types.js'
import type { TypstSlashCommand } from './insert-commands.js'
import { sourceInsertEntries } from './source-insertions.js'

const SourceContext = createContext<{
	project: TypstSourceProject
	path: string
	editable: boolean
} | null>(null)

function SourceView(props: NodeViewProps) {
	const source = useContext(SourceContext)!
	const inline = props.node.type.name === 'typstInlineSource'
	const [draft, setDraft] = useState<{
		value: string
		base: string
		revision: number
		from: number
		to: number
	} | null>(null)
	const [error, setError] = useState('')
	const begin = () => {
		const projection = source.project.open(source.path)
		const position = props.getPos()
		const mapping = projection.mapping.find(
			(item) => item.position === position && item.kind === 'source',
		)
		if (!mapping) {
			setError('源码位置已改变，请重新打开此节点。')
			return
		}
		setDraft({
			value: props.node.attrs.source,
			base: props.node.attrs.source,
			revision: source.project.revision,
			from: mapping.from,
			to: mapping.to,
		})
	}
	const apply = () => {
		if (!draft || !source.editable || !props.editor.isEditable || props.editor.view.composing)
			return
		const result = source.project.apply({
			baseRevision: draft.revision,
			patches: [{ path: source.path, from: draft.from, to: draft.to, text: draft.value }],
		})
		if (!result.ok) {
			setError(result.issues.map((issue) => issue.message).join('\n'))
			return
		}
		setDraft(null)
		setError('')
	}
	return (
		<NodeViewWrapper
			as={inline ? 'span' : 'div'}
			contentEditable={false}
			className={inline ? 'typst-inline-source' : 'typst-source-card'}
		>
			{!draft ? (
				<button type="button" onClick={begin} title="打开 Typst 源码">
					<code>{props.node.attrs.source}</code>
				</button>
			) : (
				<>
					<textarea
						aria-label="Typst 源码"
						value={draft.value}
						data-typst-unapplied={draft.value !== draft.base || undefined}
						readOnly={!props.editor.isEditable}
						onChange={(event) => setDraft({ ...draft, value: event.currentTarget.value })}
						onKeyDown={(event) => {
							if (
								!event.nativeEvent.isComposing &&
								event.key === 'Enter' &&
								(event.ctrlKey || event.metaKey)
							) {
								event.preventDefault()
								apply()
							}
						}}
					/>
					<button type="button" disabled={!props.editor.isEditable} onClick={apply}>
						应用源码
					</button>
					<button
						type="button"
						onClick={() => {
							setDraft(null)
							setError('')
						}}
					>
						取消
					</button>
				</>
			)}
			{error && <span role="alert">{error}</span>}
		</NodeViewWrapper>
	)
}

function jsonKey(value: unknown, key: string | number): string | number {
	return Array.isArray(value) && /^\d+$/.test(String(key)) ? Number(key) : key
}

/** Every data control edits the actual JSON file with the revision captured when it opened. */
function JsonBinding({ file, keys }: { file: string; keys?: readonly (string | number)[] }) {
	const { project, editable } = useContext(SourceContext)!
	const [draft, setDraft] = useState<{ text: string; revision: number; source: string } | null>(
		null,
	)
	const [error, setError] = useState('')
	const open = () => {
		try {
			const contents = project.snapshot().files[file]
			if (contents === undefined) throw new Error(`File does not exist: ${file}`)
			const source =
				typeof contents === 'string'
					? contents
					: new TextDecoder('utf-8', { fatal: true }).decode(contents)
			let value = JSON.parse(source)
			for (const key of keys ?? []) {
				if (
					value === null ||
					typeof value !== 'object' ||
					!Object.hasOwn(value, jsonKey(value, key))
				)
					throw new Error(`JSON 字段不存在：${keys?.join('.')}`)
				value = value[jsonKey(value, key)]
			}
			setDraft({ text: JSON.stringify(value, null, 2), revision: project.revision, source })
			setError('')
		} catch (cause) {
			setError(String(cause))
		}
	}
	const apply = () => {
		if (!draft || !editable) return
		try {
			let value = JSON.parse(draft.text)
			if (keys?.length) {
				const data = JSON.parse(draft.source)
				let parent = data
				for (const key of keys.slice(0, -1)) parent = parent[jsonKey(parent, key)]
				const final = jsonKey(parent, keys.at(-1)!)
				if (Array.isArray(parent) && final === 'length')
					throw new Error('数组长度是派生值，请编辑实际JSON数组。')
				parent[final] = value
				value = data
			}
			const result = project.apply({
				baseRevision: draft.revision,
				patches: [
					{
						path: file,
						from: 0,
						to: new TextEncoder().encode(draft.source).length,
						text: JSON.stringify(value, null, 2) + '\n',
					},
				],
			})
			if (!result.ok) {
				setError(result.issues.map((issue) => issue.message).join('\n'))
				return
			}
			setDraft(null)
			setError('')
		} catch (cause) {
			setError(String(cause))
		}
	}
	return (
		<span className="typst-json-binding">
			<button type="button" onClick={open}>
				数据：{file}
				{keys?.length ? ` · ${keys.join('.')}` : ''}
			</button>
			{draft && (
				<span className="typst-binding-controls">
					<textarea
						aria-label={`JSON ${file}`}
						readOnly={!editable}
						value={draft.text}
						onChange={(event) => setDraft({ ...draft, text: event.currentTarget.value })}
						data-typst-unapplied
					/>
					<button type="button" disabled={!editable} onClick={apply}>
						保存 JSON
					</button>
					<button
						type="button"
						onClick={() => {
							setDraft(null)
							setError('')
						}}
					>
						取消
					</button>
				</span>
			)}
			{error && <span role="alert">{error}</span>}
		</span>
	)
}

function FieldView(props: NodeViewProps) {
	const { project } = useContext(SourceContext)!
	useSyncExternalStore(project.subscribe, () => project.revision)
	let displayed: string
	let editableKeys = props.node.attrs.path
	try {
		const file = project.snapshot().files[props.node.attrs.file]
		if (file === undefined) throw new Error('JSON 文件不存在')
		let value = JSON.parse(
			typeof file === 'string' ? file : new TextDecoder('utf-8', { fatal: true }).decode(file),
		)
		for (const key of props.node.attrs.path) {
			if (Array.isArray(value) && key === 'length') editableKeys = undefined
			if (value === null || typeof value !== 'object' || !Object.hasOwn(value, jsonKey(value, key)))
				throw new Error('JSON 字段不存在')
			value = value[jsonKey(value, key)]
		}
		displayed =
			value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value)
	} catch (cause) {
		displayed = String(cause)
	}
	return (
		<NodeViewWrapper as="span" contentEditable={false} className="typst-source-field">
			<span>{displayed}</span>
			<JsonBinding file={props.node.attrs.file} keys={editableKeys} />
		</NodeViewWrapper>
	)
}

function ComponentView(props: NodeViewProps) {
	const { project, editable } = useContext(SourceContext)!
	const [draft, setDraft] = useState<{ props: Record<string, unknown>; revision: number } | null>(
		null,
	)
	const [error, setError] = useState('')
	const parameters = props.node.attrs.parameters as Record<
		string,
		{ type: string; label?: string }
	> | null
	return (
		<NodeViewWrapper contentEditable={false} className="typst-source-card typst-component">
			<strong>{props.node.attrs.label}</strong>
			<code>
				{props.node.attrs.module} · {props.node.attrs.name}
			</code>
			<button
				type="button"
				disabled={!editable || !props.editor.isEditable}
				onClick={() => {
					setDraft({ props: { ...props.node.attrs.props }, revision: project.revision })
					setError('')
				}}
			>
				编辑参数
			</button>
			{draft && (
				<form
					data-typst-unapplied
					onSubmit={(event) => {
						event.preventDefault()
						if (!editable || !props.editor.isEditable || props.editor.view.composing) return
						if (draft.revision !== project.revision) {
							setError('源码已改变，请重新打开参数后修改。')
							return
						}
						props.updateAttributes({ props: draft.props })
						const position = props.getPos()
						const actual =
							position === undefined
								? undefined
								: props.editor.state.doc.nodeAt(position)?.attrs.props
						if (
							!actual ||
							Object.keys(actual).length !== Object.keys(draft.props).length ||
							Object.keys(draft.props).some((key) => actual[key] !== draft.props[key])
						) {
							setError('参数修改未接纳，请查看源码诊断。')
							return
						}
						setDraft(null)
					}}
				>
					{Object.entries(parameters ?? {}).map(([name, definition]) => (
						<label key={name}>
							{definition.label ?? name}
							{definition.type === 'boolean' ? (
								<select
									aria-label={definition.label ?? name}
									value={draft.props[name] === undefined ? '' : String(draft.props[name])}
									onChange={(event) =>
										setDraft({
											...draft,
											props: { ...draft.props, [name]: event.currentTarget.value === 'true' },
										})
									}
								>
									<option value="" disabled>
										模板默认
									</option>
									<option value="true">是</option>
									<option value="false">否</option>
								</select>
							) : (
								<input
									aria-label={definition.label ?? name}
									type={definition.type === 'number' ? 'number' : 'text'}
									step="any"
									placeholder="模板默认"
									value={String(draft.props[name] ?? '')}
									onChange={(event) =>
										setDraft({
											...draft,
											props: {
												...draft.props,
												[name]:
													definition.type === 'number'
														? Number(event.currentTarget.value)
														: event.currentTarget.value,
											},
										})
									}
								/>
							)}
						</label>
					))}
					<button type="submit">应用参数</button>
					<button type="button" onClick={() => setDraft(null)}>
						取消
					</button>
				</form>
			)}
			{props.node.attrs.binding && <JsonBinding file={props.node.attrs.binding.file} />}
			{error && <span role="alert">{error}</span>}
		</NodeViewWrapper>
	)
}

function SourceImageView(props: NodeViewProps) {
	const { project, path } = useContext(SourceContext)!
	const revision = useSyncExternalStore(project.subscribe, () => project.revision)
	const [url, setUrl] = useState('')
	useEffect(() => {
		const src = String(props.node.attrs.src ?? '')
		if (/^(?:https?:|data:)/.test(src)) {
			setUrl(src)
			return
		}
		const resolved = new URL(src, `https://project.invalid/${path}`)
		const file = decodeURIComponent(resolved.pathname.slice(1))
		const value = project.snapshot().files[file]
		if (resolved.origin !== 'https://project.invalid' || value === undefined) {
			setUrl('')
			return
		}
		const types: Record<string, string> = {
			svg: 'image/svg+xml',
			png: 'image/png',
			jpg: 'image/jpeg',
			jpeg: 'image/jpeg',
			gif: 'image/gif',
			webp: 'image/webp',
		}
		const data = typeof value === 'string' ? value : Uint8Array.from(value)
		const objectUrl = URL.createObjectURL(
			new Blob([data], { type: types[file.split('.').at(-1)!] ?? 'application/octet-stream' }),
		)
		setUrl(objectUrl)
		return () => URL.revokeObjectURL(objectUrl)
	}, [project, path, revision, props.node.attrs.src])
	return (
		<NodeViewWrapper contentEditable={false}>
			{url ? (
				<img
					src={url}
					alt={props.node.attrs.alt ?? ''}
					title={props.node.attrs.title ?? undefined}
				/>
			) : (
				<span role="status">图片资源：{props.node.attrs.src}</span>
			)}
		</NodeViewWrapper>
	)
}

export interface TypstSourceEditorProps {
	project: TypstSourceProject
	path: string
	editable?: boolean
	toolbar?: boolean
	className?: string
	fontFamilies?: readonly string[]
	slashCommands?: readonly TypstSlashCommand[]
	onEditor?(editor: Editor | null): void
	onSelection?(position: number): void
	onReveal?(position: number): void
	onReference?(path: string, position: number): void
	onIssues?(issues: readonly TypstSourceDiagnostic[]): void
	children?: (editor: Editor) => ReactNode
}

/** Structured view of one ordinary .typ file; the shared project owns source and history. */
export function TypstSourceEditor(props: TypstSourceEditorProps) {
	const latest = useRef(props)
	latest.current = props
	const [editor, setEditor] = useState<Editor | null>(null)
	const [issues, setIssues] = useState<readonly TypstSourceDiagnostic[]>([])
	const [composing, setComposing] = useState(false)
	const revision = useSyncExternalStore(
		props.project.subscribe,
		() => props.project.revision,
		() => props.project.revision,
	)
	const source = useMemo(
		() => ({ project: props.project, path: props.path, editable: props.editable !== false }),
		[props.project, props.path, props.editable],
	)
	const referenceTargets = useMemo(() => {
		let atRevision = -1
		let values: TypstReferenceTarget[] = []
		return () => {
			if (atRevision === props.project.revision) return values
			values = []
			for (const path of Object.keys(props.project.snapshot().files).filter((file) =>
				file.endsWith('.typ'),
			)) {
				for (const label of props.project.open(path).labels) {
					if (!label.target || label.target.kind === 'heading') continue
					values.push({
						label: label.label,
						path,
						kind: label.target.kind,
						position: label.target.position,
						title: label.target.title,
					})
				}
			}
			atRevision = props.project.revision
			return values
		}
	}, [props.project])
	useEffect(() => {
		const instance = createTypstSourceEditor({
			element: document.createElement('div'),
			project: props.project,
			path: props.path,
			editable: props.editable,
			extensions: [
				Image.extend({ addNodeView: () => ReactNodeViewRenderer(SourceImageView) }),
				TypstSourceBlock.extend({ addNodeView: () => ReactNodeViewRenderer(SourceView) }),
				TypstInlineSource.extend({ addNodeView: () => ReactNodeViewRenderer(SourceView) }),
				TypstComponent.extend({ addNodeView: () => ReactNodeViewRenderer(ComponentView) }),
				TypstField.extend({ addNodeView: () => ReactNodeViewRenderer(FieldView) }),
				TypstFigure.extend({
					content: '(image | table | typstSource | typstComponent) figureCaption',
					addNodeView: () => ReactNodeViewRenderer(TypstFigureView),
				}),
				TypstBlockMath.extend({ addNodeView: () => ReactNodeViewRenderer(TypstMathView) }),
				TypstInlineMath.extend({ addNodeView: () => ReactNodeViewRenderer(TypstMathView) }),
				TypstReference.extend({ addNodeView: () => ReactNodeViewRenderer(TypstReferenceView) }),
				createReferenceSuggestion(() => ({
					editable: latest.current.editable,
					referenceTargets,
				})),
			],
			onIssues(next) {
				setIssues(next)
				latest.current.onIssues?.(next)
			},
			onSelectionUpdate({ editor: selectedEditor }) {
				latest.current.onSelection?.(selectedEditor.state.selection.from)
			},
		})
		setEditor(instance)
		latest.current.onEditor?.(instance)
		return () => {
			latest.current.onEditor?.(null)
			instance.destroy()
		}
	}, [props.project, props.path])
	useEffect(() => {
		editor?.setEditable(props.editable ?? true, false)
	}, [editor, props.editable])
	const diagnostics = useMemo(() => {
		try {
			return props.project.diagnostics().filter((issue) => issue.path === props.path)
		} catch {
			return []
		}
	}, [props.project, props.path, revision])
	const insertions = useMemo(() => {
		try {
			return sourceInsertEntries(props.project, props.path)
		} catch (cause) {
			return { entries: () => [], problems: [`插入目录不可用：${String(cause)}`] }
		}
	}, [props.project, props.path, revision])
	const ui = useMemo<EditorUiContext>(
		() => ({
			referenceTargets,
			prepareDuplicate: (instance, position) =>
				prepareTypstSourceCopy(instance, props.project, props.path, position),
			validateDocument: (document) =>
				props.project.prepareEdit({ projection: props.project.open(props.path), document }).ok,
			onReference: props.onReference,
			composing,
			editable: props.editable !== false,
			onReveal: props.onReveal,
			fontFamilies: props.fontFamilies ?? [],
			slashCommands: props.slashCommands ?? [],
			sourceEntries: insertions.entries,
		}),
		[
			referenceTargets,
			props.project,
			props.path,
			props.onReference,
			composing,
			props.editable,
			props.onReveal,
			props.fontFamilies,
			props.slashCommands,
			insertions.entries,
		],
	)
	return (
		<SourceContext.Provider value={source}>
			<EditorUi.Provider value={ui}>
				<div
					className={['typst-editor', props.className].filter(Boolean).join(' ')}
					data-readonly={props.editable === false || undefined}
					onCompositionStartCapture={() => setComposing(true)}
					onCompositionEndCapture={() => setComposing(false)}
				>
					{[...diagnostics, ...issues].length > 0 && (
						<div role="alert" className="typst-editor-error">
							{[...diagnostics, ...issues]
								.map((issue) => `${issue.path}:${issue.from} ${issue.code}: ${issue.message}`)
								.join('\n')}
						</div>
					)}
					{editor && props.toolbar !== false && <TypstEditorToolbar editor={editor} />}
					{insertions.problems.length > 0 && (
						<details className="typst-source-insertion-problems">
							<summary>部分插入项不可用</summary>
							{insertions.problems.map((problem, index) => (
								<p key={index}>{problem}</p>
							))}
						</details>
					)}
					{editor && props.children?.(editor)}
					<EditorContent editor={editor} className="typst-editor-content" />
					{editor && <EditorMenus editor={editor} />}
				</div>
			</EditorUi.Provider>
		</SourceContext.Provider>
	)
}
