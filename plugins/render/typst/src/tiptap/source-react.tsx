import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type MouseEvent,
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
import type { TypstSourceComponent, TypstSourceDiagnostic } from '../source/types.js'
import {
	createTypstSourceEditor,
	prepareTypstSourceCopy,
	TypstInlineSource,
	TypstSourceBlock,
	TypstComponent,
	TypstField,
	TypstImport,
	TypstInclude,
} from './source-editor.js'
import { TypstFigure, TypstBlockMath, TypstInlineMath, TypstReference } from './document-nodes.js'
import {
	TypstFigureView,
	TypstMathView,
	TypstReferenceView,
	createReferenceSuggestion,
} from './document-react.js'
import { EditorUi, Icon, type EditorUiContext } from './editor-ui.js'
import { EditorMenus, TypstEditorToolbar } from './ui.js'
import type { TypstReferenceTarget } from './types.js'
import type { TypstSlashCommand } from './insert-commands.js'
import { sourceInsertEntries } from './source-insertions.js'
import {
	SourceActions,
	SourcePopover,
	focusOpenSourcePanel,
	findPendingSourceInput,
	restoreSourceFocus,
} from './source-controls.js'
import { SourceFileForm, SourcePathInput } from './source-file-input.js'
import { resolveSourcePath } from './source-paths.js'

/** A component's local parameter form. Applying, history and source admission stay with the editor. */
export interface TypstComponentParametersProps {
	readonly component: TypstSourceComponent
	readonly values: Readonly<Record<string, string | number | boolean>>
	readonly disabled: boolean
	onChange(values: Readonly<Record<string, string | number | boolean>>): void
}

const SourceContext = createContext<{
	project: TypstSourceProject
	path: string
	editable: boolean
	editableFields: TypstSourceEditorProps['editableFields']
	onOpenFile?: (path: string) => void
	renderComponentParameters?: TypstSourceEditorProps['renderComponentParameters']
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
	const anchor = useRef<HTMLButtonElement>(null)
	const close = (restoreFocus = true) => {
		setDraft(null)
		setError('')
		if (restoreFocus) restoreSourceFocus(anchor.current, props.editor)
	}
	const begin = () => {
		if (focusOpenSourcePanel(anchor.current) || draft) return
		const projection = source.project.open(source.path)
		const position = props.getPos()
		const mapping = projection.mapping.find(
			(item) => item.position === position && item.kind === 'source',
		)
		if (!mapping) {
			setError('源码位置已改变，请重新打开此节点。')
			return
		}
		if (typeof position === 'number') props.editor.commands.setNodeSelection(position)
		setDraft({
			value: props.node.attrs.source,
			base: props.node.attrs.source,
			revision: source.project.revision,
			from: mapping.from,
			to: mapping.to,
		})
	}
	const apply = () => {
		if (
			!draft ||
			draft.value === draft.base ||
			!source.editable ||
			!props.editor.isEditable ||
			props.editor.view.composing
		)
			return
		const result = source.project.apply({
			baseRevision: draft.revision,
			patches: [{ path: source.path, from: draft.from, to: draft.to, text: draft.value }],
		})
		if (!result.ok) {
			setError(result.issues.map((issue) => issue.message).join('\n'))
			return
		}
		close()
	}
	return (
		<NodeViewWrapper
			as={inline ? 'span' : 'div'}
			contentEditable={false}
			className={inline ? 'typst-inline-source' : 'typst-source-card typst-preserved-source'}
			data-selected={props.selected || undefined}
		>
			<button
				ref={anchor}
				className="typst-source-trigger"
				type="button"
				onClick={begin}
				title="打开 Typst 源码"
				aria-expanded={Boolean(draft)}
			>
				{!inline && <Icon name="code" />}
				<code>{props.node.attrs.source}</code>
			</button>
			{draft && (
				<SourcePopover
					editor={props.editor}
					anchor={anchor}
					title="Typst 源码"
					description={source.path}
					dirty={draft.value !== draft.base}
					onClose={close}
				>
					<form
						onSubmit={(event) => {
							event.preventDefault()
							apply()
						}}
					>
						<textarea
							aria-label="Typst 源码"
							value={draft.value}
							data-typst-unapplied={draft.value !== draft.base || undefined}
							readOnly={!props.editor.isEditable}
							onChange={(event) => setDraft({ ...draft, value: event.currentTarget.value })}
						/>
						{error && <p role="alert">{error}</p>}
						<SourceActions
							label="应用源码"
							disabled={!props.editor.isEditable || draft.value === draft.base}
							onCancel={close}
						/>
					</form>
				</SourcePopover>
			)}
			{!draft && error && <span role="alert">{error}</span>}
		</NodeViewWrapper>
	)
}

function jsonKey(value: unknown, key: string | number): string | number {
	return Array.isArray(value) && /^\d+$/.test(String(key)) ? Number(key) : key
}

function SourceFileLink({
	module,
	path,
	project,
	onOpenFile,
}: {
	module: string
	path: string
	project: TypstSourceProject
	onOpenFile?: (path: string) => void
}) {
	const resolved = resolveSourcePath(path, module)
	const target =
		resolved && Object.hasOwn(project.snapshot().files, resolved) ? resolved : undefined
	const name = module.slice(module.lastIndexOf('/') + 1)
	const label = (
		<code>
			<span className="typst-import-directory">{module.slice(0, -name.length)}</span>
			<span>{name}</span>
		</code>
	)
	return target && onOpenFile ? (
		<button
			className="typst-import-module"
			type="button"
			aria-label={module}
			title={`打开文件 ${target}`}
			onClick={() => onOpenFile(target)}
		>
			{label}
		</button>
	) : (
		<span className="typst-import-module">{label}</span>
	)
}

function IncludeView(props: NodeViewProps) {
	const { project, path, onOpenFile } = useContext(SourceContext)!
	const anchor = useRef<HTMLButtonElement>(null)
	const [draft, setDraft] = useState<{ module: string; revision: number } | null>(null)
	const [error, setError] = useState('')
	const disabled = !props.editor.isEditable
	const changed = draft && draft.module !== props.node.attrs.module
	const close = (restoreFocus = true) => {
		setDraft(null)
		setError('')
		if (restoreFocus) restoreSourceFocus(anchor.current, props.editor)
	}
	const apply = (module = draft?.module) => {
		if (!draft || module === undefined || disabled || props.editor.view.composing) return
		if (project.revision !== draft.revision) {
			setError('源码已改变，请重新打开章节设置。')
			return
		}
		props.updateAttributes({ module })
		const at = props.getPos()
		if (typeof at !== 'number' || props.editor.state.doc.nodeAt(at)?.attrs.module !== module) {
			setError('章节路径未接纳，请查看源码诊断。')
			return
		}
		close()
	}
	return (
		<NodeViewWrapper
			contentEditable={false}
			className="typst-include typst-file-reference"
			data-selected={props.selected || undefined}
		>
			<Icon name="text" />
			<span className="typst-import-kind">章节</span>
			<SourceFileLink
				module={props.node.attrs.module}
				path={path}
				project={project}
				onOpenFile={onOpenFile}
			/>
			<span className="typst-import-binding">独立文件 · 内容在预览中显示</span>
			<button
				ref={anchor}
				type="button"
				className="typst-node-settings"
				aria-label="章节设置"
				aria-expanded={Boolean(draft)}
				onClick={() => {
					if (focusOpenSourcePanel(anchor.current) || draft) return
					const at = props.getPos()
					if (typeof at === 'number') props.editor.commands.setNodeSelection(at)
					setDraft({ module: props.node.attrs.module, revision: project.revision })
					setError('')
				}}
			>
				<Icon name="more" />
			</button>
			{draft && (
				<SourcePopover
					editor={props.editor}
					anchor={anchor}
					title="章节文件"
					description="此文件的正文在这里排版；打开文件可继续编辑章节。"
					dirty={Boolean(changed)}
					onClose={close}
				>
					<form
						data-typst-unapplied={changed || undefined}
						onSubmit={(event) => {
							event.preventDefault()
							apply()
						}}
					>
						<SourcePathInput
							files={Object.keys(project.snapshot().files)}
							path={path}
							value={draft.module}
							onChange={(module) => setDraft({ ...draft, module })}
							onAccept={apply}
							label="章节路径"
							readOnly={disabled}
						/>
						{error && <p role="alert">{error}</p>}
						<SourceActions label="应用章节" disabled={disabled || !changed} onCancel={close} />
					</form>
				</SourcePopover>
			)}
		</NodeViewWrapper>
	)
}

function ImportView(props: NodeViewProps) {
	const { project, path, onOpenFile } = useContext(SourceContext)!
	const anchor = useRef<HTMLButtonElement>(null)
	const [draft, setDraft] = useState<{
		module: string
		mode: 'namespace' | 'items'
		alias: string
		items: string
		revision: number
	} | null>(null)
	const [error, setError] = useState('')
	const attrs = props.node.attrs
	const disabled = !props.editor.isEditable
	const close = (restoreFocus = true) => {
		setDraft(null)
		setError('')
		if (restoreFocus) restoreSourceFocus(anchor.current, props.editor)
	}
	const apply = (module = draft?.module) => {
		if (!draft || module === undefined || disabled || props.editor.view.composing) return
		if (draft.revision !== project.revision) {
			setError('源码已改变，请重新打开导入设置。')
			return
		}
		const next = {
			module,
			alias: draft.mode === 'namespace' ? draft.alias.trim() || null : null,
			items: draft.mode === 'items' ? draft.items.trim() : null,
		}
		props.updateAttributes(next)
		const at = props.getPos()
		const actual = typeof at === 'number' ? props.editor.state.doc.nodeAt(at)?.attrs : undefined
		if (!actual || Object.entries(next).some(([key, value]) => actual[key] !== value)) {
			setError('导入修改未接纳，请查看源码诊断；复杂声明可在源码视图修改。')
			return
		}
		close()
	}
	const changed =
		draft &&
		(draft.module !== attrs.module ||
			(draft.mode === 'namespace' ? draft.alias.trim() || null : null) !== attrs.alias ||
			(draft.mode === 'items' ? draft.items.trim() : null) !== attrs.items)
	return (
		<NodeViewWrapper
			contentEditable={false}
			className="typst-import typst-file-reference"
			data-selected={props.selected || undefined}
		>
			<Icon name="link" />
			<span className="typst-import-kind">导入</span>
			<SourceFileLink module={attrs.module} path={path} project={project} onOpenFile={onOpenFile} />
			<span className="typst-import-binding">
				{attrs.items ? `: ${attrs.items}` : attrs.alias ? `as ${attrs.alias}` : '模块命名空间'}
			</span>
			<button
				ref={anchor}
				type="button"
				className="typst-node-settings"
				aria-label="导入设置"
				aria-expanded={Boolean(draft)}
				onClick={() => {
					if (focusOpenSourcePanel(anchor.current) || draft) return
					const at = props.getPos()
					if (typeof at === 'number') props.editor.commands.setNodeSelection(at)
					setDraft({
						module: attrs.module,
						mode: attrs.items == null ? 'namespace' : 'items',
						alias: attrs.alias ?? '',
						items: attrs.items ?? '',
						revision: project.revision,
					})
					setError('')
				}}
			>
				<Icon name="more" />
			</button>
			{draft && (
				<SourcePopover
					editor={props.editor}
					anchor={anchor}
					title="模块导入"
					description="导入声明保留在原位，供后面的正文与组件使用。"
					dirty={Boolean(changed)}
					onClose={close}
				>
					<form
						data-typst-unapplied={changed || undefined}
						onSubmit={(event) => {
							event.preventDefault()
							apply()
						}}
					>
						<SourcePathInput
							files={Object.keys(project.snapshot().files)}
							path={path}
							value={draft.module}
							onChange={(module) => setDraft({ ...draft, module })}
							onAccept={apply}
							label="模块路径"
							readOnly={disabled}
						/>
						<label className="typst-node-control-label">
							导入方式
							<select
								aria-label="导入方式"
								disabled={disabled}
								value={draft.mode}
								onChange={(event) =>
									setDraft({ ...draft, mode: event.currentTarget.value as 'namespace' | 'items' })
								}
							>
								<option value="namespace">模块命名空间</option>
								<option value="items">指定成员</option>
							</select>
						</label>
						{draft.mode === 'namespace' ? (
							<label className="typst-node-control-label">
								模块别名
								<input
									aria-label="模块别名"
									placeholder="使用模块名"
									value={draft.alias}
									readOnly={disabled}
									onChange={(event) => setDraft({ ...draft, alias: event.currentTarget.value })}
								/>
							</label>
						) : (
							<label className="typst-node-control-label">
								导入成员
								<input
									aria-label="导入成员"
									placeholder="metrics, chart as revenue-chart 或 *"
									value={draft.items}
									readOnly={disabled}
									onChange={(event) => setDraft({ ...draft, items: event.currentTarget.value })}
								/>
							</label>
						)}
						{error && <p role="alert">{error}</p>}
						<SourceActions label="应用导入" disabled={disabled || !changed} onCancel={close} />
					</form>
				</SourcePopover>
			)}
		</NodeViewWrapper>
	)
}

/** Every data control edits the actual JSON file with the revision captured when it opened. */
function JsonBinding({
	editor,
	file,
	keys,
	label,
	onOpen,
	readOnly = false,
}: {
	editor: Editor
	file: string
	keys?: readonly (string | number)[]
	label?: string
	onOpen?(): void
	readOnly?: boolean
}) {
	const { project, editable, editableFields } = useContext(SourceContext)!
	const writable =
		!readOnly &&
		editable &&
		project.isWritable(file) &&
		Boolean(
			editableFields?.some(
				(field) =>
					field.file === file &&
					field.path.length <= (keys?.length ?? 0) &&
					field.path.every((key, index) => String(key) === String(keys![index])),
			),
		)
	const [draft, setDraft] = useState<{
		text: string
		base: string
		kind: 'string' | 'number' | 'boolean' | 'json'
		revision: number
		source: string
	} | null>(null)
	const [error, setError] = useState('')
	const anchor = useRef<HTMLButtonElement>(null)
	const close = (restoreFocus = true) => {
		setDraft(null)
		setError('')
		if (restoreFocus) restoreSourceFocus(anchor.current, editor)
	}
	const open = () => {
		if (focusOpenSourcePanel(anchor.current) || draft) return
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
			const kind =
				keys?.length &&
				(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
					? (typeof value as 'string' | 'number' | 'boolean')
					: 'json'
			const text = kind === 'string' ? String(value) : JSON.stringify(value, null, 2)
			setDraft({ text, base: text, kind, revision: project.revision, source })
			setError('')
			onOpen?.()
		} catch (cause) {
			setError(String(cause))
		}
	}
	const apply = () => {
		if (!draft || draft.text === draft.base || !writable) return
		try {
			let value = draft.kind === 'string' ? draft.text : JSON.parse(draft.text)
			if (
				draft.kind !== 'json' &&
				(typeof value !== draft.kind || (typeof value === 'number' && !Number.isFinite(value)))
			)
				throw new Error('字段值与原有类型不一致。')
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
			close()
		} catch (cause) {
			setError(String(cause))
		}
	}
	if (keys && !writable)
		return (
			<span className="typst-field-readonly" title={`只读字段：${file} · ${keys.join('.')}`}>
				{label}
			</span>
		)
	return (
		<span className="typst-json-binding">
			<button
				ref={anchor}
				type="button"
				onClick={open}
				aria-expanded={Boolean(draft)}
				aria-label={label ?? `数据：${file}${keys?.length ? ` · ${keys.join('.')}` : ''}`}
				title={`数据来源：${file}${keys?.length ? ` · ${keys.join('.')}` : ''}`}
			>
				{label ?? '共享数据'}
			</button>
			{draft && (
				<SourcePopover
					editor={editor}
					anchor={anchor}
					title={
						keys?.length ? `字段 · ${keys.join('.')}` : writable ? '共享数据' : '共享数据（只读）'
					}
					description={`${file}${keys?.length ? ` · ${keys.join('.')}` : ''}`}
					dirty={draft.text !== draft.base}
					onClose={close}
				>
					<form
						className="typst-binding-controls"
						data-typst-unapplied={draft.text !== draft.base || undefined}
						onSubmit={(event) => {
							event.preventDefault()
							apply()
						}}
					>
						{draft.kind === 'json' ? (
							<textarea
								aria-label={`JSON ${file}`}
								readOnly={!writable}
								value={draft.text}
								onChange={(event) => setDraft({ ...draft, text: event.currentTarget.value })}
							/>
						) : (
							<label className="typst-node-control-label">
								字段值
								{draft.kind === 'boolean' ? (
									<select
										aria-label={`字段值 ${keys?.join('.')}`}
										disabled={!writable}
										value={draft.text}
										onChange={(event) => setDraft({ ...draft, text: event.currentTarget.value })}
									>
										<option value="true">是</option>
										<option value="false">否</option>
									</select>
								) : (
									<input
										aria-label={`字段值 ${keys?.join('.')}`}
										type={draft.kind === 'number' ? 'number' : 'text'}
										step={draft.kind === 'number' ? 'any' : undefined}
										readOnly={!writable}
										value={draft.text}
										onChange={(event) => setDraft({ ...draft, text: event.currentTarget.value })}
									/>
								)}
							</label>
						)}
						{error && <p role="alert">{error}</p>}
						{writable ? (
							<SourceActions
								label="保存 JSON"
								disabled={draft.text === draft.base}
								onCancel={close}
							/>
						) : (
							<div className="typst-node-panel-actions">
								<button type="button" onClick={() => close()}>
									关闭
								</button>
							</div>
						)}
					</form>
				</SourcePopover>
			)}
			{!draft && error && <span role="alert">{error}</span>}
		</span>
	)
}

function FieldView(props: NodeViewProps) {
	const { project } = useContext(SourceContext)!
	useSyncExternalStore(project.subscribe, () => project.revision)
	let displayed: string
	let derived = false
	try {
		const file = project.snapshot().files[props.node.attrs.file]
		if (file === undefined) throw new Error('JSON 文件不存在')
		let value = JSON.parse(
			typeof file === 'string' ? file : new TextDecoder('utf-8', { fatal: true }).decode(file),
		)
		for (const key of props.node.attrs.path) {
			if (Array.isArray(value) && key === 'length') derived = true
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
			<JsonBinding
				editor={props.editor}
				file={props.node.attrs.file}
				keys={props.node.attrs.path}
				readOnly={derived}
				label={displayed || '未填写'}
				onOpen={() => {
					const at = props.getPos()
					if (typeof at === 'number') props.editor.commands.setNodeSelection(at)
				}}
			/>
		</NodeViewWrapper>
	)
}

function ComponentView(props: NodeViewProps) {
	const { project, editable, renderComponentParameters } = useContext(SourceContext)!
	const [draft, setDraft] = useState<{
		props: Record<string, string | number | boolean>
		revision: number
	} | null>(null)
	const [error, setError] = useState('')
	const anchor = useRef<HTMLButtonElement>(null)
	const parameters = props.node.attrs.parameters as Record<
		string,
		{ type: string; label?: string }
	> | null
	const component = project.components.find(
		(value) => value.module === props.node.attrs.module && value.name === props.node.attrs.name,
	)
	const disabled = !editable || !props.editor.isEditable
	const close = (restoreFocus = true) => {
		setDraft(null)
		setError('')
		if (restoreFocus) restoreSourceFocus(anchor.current, props.editor)
	}
	const begin = (event: MouseEvent<HTMLButtonElement>) => {
		if (focusOpenSourcePanel(anchor.current ?? event.currentTarget) || draft) return
		anchor.current = event.currentTarget
		const at = props.getPos()
		if (typeof at === 'number') props.editor.commands.setNodeSelection(at)
		setDraft({ props: { ...props.node.attrs.props }, revision: project.revision })
		setError('')
	}
	const customParameters =
		draft && component
			? renderComponentParameters?.({
					component,
					values: draft.props,
					disabled: disabled || draft.revision !== project.revision,
					onChange(values) {
						if (disabled || draft.revision !== project.revision) return
						setDraft((current) =>
							current === draft ? { ...current, props: { ...values } } : current,
						)
					},
				})
			: undefined
	return (
		<NodeViewWrapper
			contentEditable={false}
			className="typst-source-card typst-component"
			data-selected={props.selected || undefined}
		>
			<span className="typst-component-kind">内容组件</span>
			{!disabled && Object.keys(parameters ?? {}).length > 0 ? (
				<button
					type="button"
					className="typst-component-title"
					title={`${props.node.attrs.module} · ${props.node.attrs.name}`}
					onClick={begin}
				>
					{typeof props.node.attrs.props?.title === 'string' && props.node.attrs.props.title
						? props.node.attrs.props.title
						: props.node.attrs.label}
				</button>
			) : (
				<strong title={`${props.node.attrs.module} · ${props.node.attrs.name}`}>
					{props.node.attrs.label}
				</strong>
			)}
			{Object.keys(parameters ?? {}).length > 0 && (
				<button
					type="button"
					className="typst-node-settings"
					aria-label="编辑参数"
					title="编辑参数"
					aria-expanded={Boolean(draft)}
					disabled={disabled}
					onClick={begin}
				>
					<Icon name="more" />
				</button>
			)}
			{props.node.attrs.binding && (
				<JsonBinding editor={props.editor} file={props.node.attrs.binding.file} />
			)}
			{draft && (
				<SourcePopover
					editor={props.editor}
					anchor={anchor}
					title={`${props.node.attrs.label}设置`}
					description={`${props.node.attrs.module} · ${props.node.attrs.name}`}
					dirty={JSON.stringify(draft.props) !== JSON.stringify(props.node.attrs.props)}
					onClose={close}
				>
					<form
						data-typst-unapplied={
							JSON.stringify(draft.props) !== JSON.stringify(props.node.attrs.props) || undefined
						}
						onSubmit={(event) => {
							event.preventDefault()
							if (!editable || !props.editor.isEditable || props.editor.view.composing) return
							if (draft.revision !== project.revision) {
								setError('源码已改变，请重新打开参数后修改。')
								return
							}
							const values = { ...draft.props }
							for (const [name, definition] of Object.entries(parameters ?? {})) {
								if (definition.type !== 'number' || typeof values[name] !== 'string') continue
								const raw = String(values[name]).trim()
								if (raw === '') delete values[name]
								else if (!Number.isFinite(Number(raw))) {
									setError(`${definition.label ?? name}：请输入有效数字，留空使用组件默认值。`)
									return
								} else values[name] = Number(raw)
							}
							props.updateAttributes({ props: values })
							const position = props.getPos()
							const actual =
								position === undefined
									? undefined
									: props.editor.state.doc.nodeAt(position)?.attrs.props
							if (
								!actual ||
								Object.keys(actual).length !== Object.keys(values).length ||
								Object.keys(values).some((key) => actual[key] !== values[key])
							) {
								setError('参数修改未接纳，请查看源码诊断。')
								return
							}
							close()
						}}
					>
						{customParameters ??
							Object.entries(parameters ?? {}).map(([name, definition]) => (
								<div key={name} className="typst-component-parameter">
									<label>
										{definition.label ?? name}
										{definition.type === 'boolean' ? (
											<select
												aria-label={definition.label ?? name}
												value={draft.props[name] === undefined ? '' : String(draft.props[name])}
												onChange={(event) => {
													const values = { ...draft.props }
													if (event.currentTarget.value === '') delete values[name]
													else values[name] = event.currentTarget.value === 'true'
													setDraft({ ...draft, props: values })
													setError('')
												}}
											>
												<option value="">组件默认</option>
												<option value="true">是</option>
												<option value="false">否</option>
											</select>
										) : (
											<input
												aria-label={definition.label ?? name}
												type={definition.type === 'number' ? 'number' : 'text'}
												step="any"
												placeholder="组件默认"
												value={String(draft.props[name] ?? '')}
												onChange={(event) =>
													setDraft({
														...draft,
														props: {
															...draft.props,
															[name]: event.currentTarget.value,
														},
													})
												}
											/>
										)}
									</label>
									<button
										type="button"
										aria-label={`恢复${definition.label ?? name}默认`}
										disabled={!Object.hasOwn(draft.props, name)}
										onClick={() => {
											const values = { ...draft.props }
											delete values[name]
											setDraft({ ...draft, props: values })
											setError('')
										}}
									>
										恢复默认
									</button>
								</div>
							))}
						{error && <p role="alert">{error}</p>}
						<SourceActions
							label="应用参数"
							disabled={
								disabled || JSON.stringify(draft.props) === JSON.stringify(props.node.attrs.props)
							}
							onCancel={close}
						/>
					</form>
				</SourcePopover>
			)}
			{!draft && error && <span role="alert">{error}</span>}
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
	/** Data controls are read-only unless listed. A path includes its subtree; [] opens the whole JSON file.
	 * File writability and editable=false still take precedence. This configures this view, not storage authorization. */
	editableFields?: readonly {
		readonly file: string
		readonly path: readonly (string | number)[]
	}[]
	toolbar?: boolean
	className?: string
	fontFamilies?: readonly string[]
	slashCommands?: readonly TypstSlashCommand[]
	/** Return null/undefined for the default form. Custom controls edit a draft; the editor applies it. */
	renderComponentParameters?(props: TypstComponentParametersProps): ReactNode
	onEditor?(editor: Editor | null): void
	/** Selection changes and completed content clicks, including a click at the same caret. */
	onSelection?(position: number): void
	onReveal?(position: number): void
	onReference?(path: string, position: number): void
	/** Open an imported project file; the host owns file selection and source/editor mode. */
	onOpenFile?(path: string): void
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
		() => ({
			project: props.project,
			path: props.path,
			editable: props.editable !== false,
			editableFields: props.editableFields,
			onOpenFile: props.onOpenFile,
			renderComponentParameters: props.renderComponentParameters,
		}),
		[
			props.project,
			props.path,
			props.editable,
			props.editableFields,
			props.renderComponentParameters,
			props.onOpenFile,
		],
	)
	const writable = props.editable !== false && props.project.isWritable(props.path)
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
				TypstImport.extend({ addNodeView: () => ReactNodeViewRenderer(ImportView) }),
				TypstInclude.extend({ addNodeView: () => ReactNodeViewRenderer(IncludeView) }),
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
		return () => {
			instance.destroy()
		}
	}, [props.project, props.path])
	useEffect(() => {
		if (!editor || editor.isDestroyed) return
		if (
			editor.state.selection.from === 0 &&
			editor.state.doc.firstChild?.type.name === 'typstImport'
		) {
			let start: number | undefined
			editor.state.doc.descendants((node, position) => {
				if (start === undefined && node.isTextblock) start = position + 1
				return start === undefined
			})
			if (start !== undefined) editor.commands.setTextSelection(start)
		}
		latest.current.onEditor?.(editor)
		return () => latest.current.onEditor?.(null)
	}, [editor])
	useEffect(() => {
		editor?.setEditable(writable, false)
	}, [editor, writable])
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
			editable: writable,
			onReveal: props.onReveal,
			fontFamilies: props.fontFamilies ?? [],
			slashCommands: props.slashCommands ?? [],
			sourceEntries: insertions.entries,
			renderSourceFileInput: (kind, onInsert, onCancel) => (
				<SourceFileForm
					project={props.project}
					path={props.path}
					kind={kind}
					onInsert={onInsert}
					onCancel={onCancel}
				/>
			),
		}),
		[
			referenceTargets,
			props.project,
			props.path,
			props.onReference,
			composing,
			writable,
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
					data-readonly={!writable || undefined}
					onMouseDownCapture={(event) => {
						const button = (event.target as Element).closest?.('button')
						if (
							button &&
							editor?.view.dom.contains(button) &&
							findPendingSourceInput(button.ownerDocument)
						) {
							// A refused popup switch must not move the insertion's captured selection.
							event.preventDefault()
							event.stopPropagation()
						}
					}}
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
					{editor && writable && props.toolbar !== false && <TypstEditorToolbar editor={editor} />}
					{writable && insertions.problems.length > 0 && (
						<details className="typst-source-insertion-problems">
							<summary>部分插入项不可用</summary>
							{insertions.problems.map((problem, index) => (
								<p key={index}>{problem}</p>
							))}
						</details>
					)}
					{editor && props.children?.(editor)}
					<EditorContent
						editor={editor}
						className="typst-editor-content"
						onClick={() => {
							if (editor && !editor.isDestroyed)
								latest.current.onSelection?.(editor.state.selection.from)
						}}
					/>
					{editor && <EditorMenus editor={editor} />}
				</div>
			</EditorUi.Provider>
		</SourceContext.Provider>
	)
}
