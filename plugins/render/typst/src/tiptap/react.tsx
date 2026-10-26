import { isTypstBlock, typstBlockPolicy } from './blocks'
import { TypstBlockView } from './blocks-react'
import {
	TypstFigureView,
	TypstMathView,
	TypstReferenceView,
	createReferenceSuggestion,
} from './document-react'
import '@tiptap/extension-text-style'
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Extension, type Editor, type Extensions, type JSONContent } from '@tiptap/core'
import { NodeSelection, Plugin } from '@tiptap/pm/state'
import { Slice } from '@tiptap/pm/model'
import { dropPoint } from '@tiptap/pm/transform'
import { copyTypstDocumentNode, isReferenceObject } from './document-nodes'
import { closeHistory } from '@tiptap/pm/history'
import { Selection } from '@tiptap/extensions/selection'
import {
	EditorContent,
	NodeViewWrapper,
	ReactNodeViewRenderer,
	useEditor,
	type NodeViewProps,
} from '@tiptap/react'
import {
	createTypstExtensions,
	DataField,
	validateTypstRegions,
	validateTypstRegion,
	parseTypstClipboard,
	fieldDisplay,
	type TypstEditorConfig,
	type TypstDataField,
	type TypstEditorIssue,
} from './index'
import { EditorMenus, TypstEditorToolbar } from './ui'
import { EditorUi } from './editor-ui'
import type { TypstSlashCommand } from './insert-commands'
import { FieldData, emptyFields } from './data-context'

export { TypstEditorToolbar } from './ui'
export type { TypstSlashCommand } from './insert-commands'
export { TypstTableStyleControls } from './table-style-controls'

/** Values are a view of host data; updating them never creates a document transaction. */
export function TypstDataProvider({
	data,
	fields = emptyFields,
	children,
}: {
	data: unknown
	fields?: readonly TypstDataField[]
	children: ReactNode
}) {
	const value = useMemo(() => ({ data, fields }), [data, fields])
	return <FieldData.Provider value={value}>{children}</FieldData.Provider>
}

export function TypstDataFieldView({ node, selected }: NodeViewProps) {
	const { data, fields } = useContext(FieldData)
	const path = node.attrs.path as string[]
	const field = fields.find((item) => JSON.stringify(item.path) === JSON.stringify(path))
	const value = field && fieldDisplay(data, field)
	return (
		<NodeViewWrapper
			as="span"
			contentEditable={false}
			data-data-field={JSON.stringify(path)}
			data-selected={selected || undefined}
			title={path.join(' / ')}
			className="typst-data-field"
		>
			{value === undefined ? `⟨${field?.label ?? path.join(' / ')}⟩` : value}
		</NodeViewWrapper>
	)
}

/** The same official extensions as /tiptap, with an optional React field NodeView. */
export function createTypstReactExtensions(config: TypstEditorConfig): Extensions {
	return createTypstExtensions(config).map((extension) =>
		extension.name === 'dataField'
			? DataField.extend({ addNodeView: () => ReactNodeViewRenderer(TypstDataFieldView) })
			: isTypstBlock(extension.name)
				? extension.extend({ addNodeView: () => ReactNodeViewRenderer(TypstBlockView) })
				: extension.name === 'figure'
					? extension.extend({ addNodeView: () => ReactNodeViewRenderer(TypstFigureView) })
					: extension.name === 'blockMath' || extension.name === 'inlineMath'
						? extension.extend({ addNodeView: () => ReactNodeViewRenderer(TypstMathView) })
						: extension.name === 'reference'
							? extension.extend({ addNodeView: () => ReactNodeViewRenderer(TypstReferenceView) })
							: extension,
	)
}

export interface TypstRegionEditorProps {
	regionId: string
	/** Initial JSON, not a controlled value; later content/data updates keep the native
	 * Editor and history. Keep config/extensions stable. Change the document key to
	 * load a full draft; changing regionId or extensions also initializes a new Editor.
	 * onChange reports snapshots for the host to save. */
	content: JSONContent
	/** All body files in this report, for cross-region references and unique labels. */
	regions?: Record<string, JSONContent>
	config: TypstEditorConfig
	data: unknown
	onChange(content: JSONContent): void
	onEditor?(editor: Editor | null): void
	onSelection?(position: number): void
	/** Reveal a component in the host's current compiled preview. */
	onReveal?(position: number): void
	/** Host business controls appear below the default toolbar; they share the native Editor. */
	children?: (editor: Editor) => ReactNode
	/** Hide only the permanent toolbar when the host provides its own controls.
	 * Context/block menus and slash insertion remain available. */
	toolbar?: boolean
	/** Families prepared by the host for Typst output; this does not install fonts. */
	fontFamilies?: readonly string[]
	className?: string
	editable?: boolean
	/** Shown for an empty region; slash insertion remains available without a placeholder. */
	placeholder?: string
	/** Extra insertion actions, shared by Insert, block-local insertion and slash search.
	 * Compose pure native chains; do not call run(), focus() or dispatch in a callback. */
	slashCommands?: readonly TypstSlashCommand[]
	/** Reports rejected initial content or native document changes. Without this
	 * callback, the component displays its own validation alert. */
	onValidationError?(issues: TypstEditorIssue[]): void
}

/** One native Editor/history per region; changing host data does not call setContent. */
export function TypstRegionEditor(props: TypstRegionEditorProps) {
	const config = useMemo(
		() => ({
			...props.config,
			regions: props.regions
				? props.config.regions
				: props.config.regions.filter((region) => region.id === props.regionId),
		}),
		[props.config, props.regionId, Boolean(props.regions)],
	)
	const admit = () => ({
		regionId: props.regionId,
		extensions: props.config.extensions,
		checked: validateTypstRegions({
			regions: { ...props.regions, [props.regionId]: props.content },
			config,
		}),
	})
	const [initial, setInitial] = useState(admit)
	const onValidationError = useRef(props.onValidationError)
	onValidationError.current = props.onValidationError
	useEffect(() => {
		if (!initial.checked.ok) onValidationError.current?.(initial.checked.issues)
	}, [initial])
	// These are the same identities that recreate useEditor's native instance. A
	// snapshot prop update alone must neither replace nor unmount a live document.
	if (initial.regionId !== props.regionId || initial.extensions !== props.config.extensions) {
		setInitial(admit())
		return null
	}
	if (!initial.checked.ok)
		return props.onValidationError ? null : (
			<div role="alert">{initial.checked.issues.map((issue) => issue.message).join('\n')}</div>
		)
	return (
		<RegionEditor {...props} content={initial.checked.value[props.regionId]!} config={config} />
	)
}

const cutMime = 'application/x-pluxel-typst-cut'
let pendingCut:
	| { token: string; html: string; document: JSONContent; moved: boolean; source: WeakRef<Editor> }
	| undefined

function objectIds(document: JSONContent) {
	const ids = new Set<string>()
	const visit = (node: JSONContent) => {
		if (
			(isReferenceObject(node.type ?? '') || isTypstBlock(node.type ?? '')) &&
			typeof node.attrs?.id === 'string'
		)
			ids.add(`${isReferenceObject(node.type ?? '') ? 'ref' : 'block'}:${node.attrs.id}`)
		node.content?.forEach(visit)
	}
	visit(document)
	return ids
}

const emptyFontFamilies: readonly string[] = []
const emptyCommands: readonly TypstSlashCommand[] = []

function RegionEditor(props: TypstRegionEditorProps) {
	const latestProps = useRef(props)
	latestProps.current = props
	const [issues, setIssues] = useState<TypstEditorIssue[]>([])
	const [composing, setComposing] = useState(false)
	const composition = useRef(false)
	const liveEditor = useRef<Editor | null>(null)
	const ui = useMemo(
		() => ({
			config: props.config,
			regions: props.regions,
			region: props.config.regions.find((region) => region.id === props.regionId),
			editable: props.editable !== false,
			composing,
			onReveal: props.onReveal,
			fontFamilies: props.fontFamilies ?? emptyFontFamilies,
			slashCommands: props.slashCommands ?? emptyCommands,
		}),
		[
			props.config,
			props.regions,
			props.regionId,
			props.editable,
			props.onReveal,
			props.fontFamilies,
			props.slashCommands,
			composing,
		],
	)
	function report(next: TypstEditorIssue[]) {
		setIssues(next)
		if (next.length > 0) latestProps.current.onValidationError?.(next)
	}
	const extensions = useMemo(
		() => [
			...createTypstReactExtensions(props.config),
			Selection.configure({ className: 'typst-selection' }),
			createReferenceSuggestion(() => latestProps.current),
			Extension.create({
				name: 'typstRegionAdmission',
				addProseMirrorPlugins: () => [
					new Plugin({
						key: typstBlockPolicy,
						state: {
							init: () => (name: string) => {
								const latest = latestProps.current
								const region = latest.config.regions.find((item) => item.id === latest.regionId)
								return (
									latest.editable !== false &&
									!composition.current &&
									(!region?.nodes || region.nodes.includes(name))
								)
							},
							apply: (_transaction, value) => value,
						},
						filterTransaction: (transaction) => {
							if (!transaction.docChanged) return true
							const latest = latestProps.current
							if (latest.editable === false) {
								report([
									{
										code: 'FORBIDDEN_REGION',
										regionId: latest.regionId,
										message: 'This region is currently read-only.',
									},
								])
								return false
							}
							const result = validateTypstRegions({
								regions: { ...latest.regions, [latest.regionId]: transaction.doc.toJSON() },
								config: latest.config,
							})
							report(result.ok ? [] : result.issues)
							return result.ok
						},
					}),
				],
			}),
		],
		[props.config.extensions, props.regionId],
	)
	const editor = useEditor(
		{
			extensions,
			content: props.content,
			editable: props.editable ?? true,
			immediatelyRender: false,
			editorProps: {
				handleDOMEvents: {
					cut: (view, event) => {
						if (
							!event.clipboardData ||
							view.state.selection.empty ||
							!view.editable ||
							view.composing
						)
							return false
						const slice = view.state.selection.content()
						if (objectIds({ type: 'doc', content: slice.content.toJSON() }).size === 0) return false
						const serialized = view.serializeForClipboard(slice)
						const token = crypto.randomUUID()
						const html = serialized.dom.innerHTML
						event.preventDefault()
						event.clipboardData.clearData()
						event.clipboardData.setData('text/html', html)
						event.clipboardData.setData('text/plain', serialized.text)
						const before = view.state.doc
						view.dispatch(
							closeHistory(view.state.tr)
								.deleteSelection()
								.scrollIntoView()
								.setMeta('uiEvent', 'cut'),
						)
						const source = liveEditor.current
						if (view.state.doc !== before && source) {
							pendingCut = {
								token,
								html,
								document: { type: 'doc', content: slice.content.toJSON() },
								moved: false,
								source: new WeakRef(source),
							}
							event.clipboardData.setData(cutMime, token)
						}
						return true
					},
				},
				handlePaste: (view, event) => {
					if (view.state.selection.$from.parent.type.name === 'codeBlock') return false
					const latest = latestProps.current
					const cut =
						pendingCut &&
						event.clipboardData?.getData(cutMime) === pendingCut.token &&
						event.clipboardData?.getData('text/html') === pendingCut.html
							? pendingCut
							: undefined
					const result = cut
						? validateTypstRegion({
								document: cut.document,
								regionId: latest.regionId,
								config: latest.config,
							})
						: parseTypstClipboard({
								html: event.clipboardData?.getData('text/html') || undefined,
								text: event.clipboardData?.getData('text/plain') ?? '',
								regionId: latest.regionId,
								config: latest.config,
							})
					if (!result.ok) {
						report(result.issues)
						return true
					}
					const source = cut?.source.deref()
					const movedIds = objectIds(result.value)
					const sourceIds =
						source && !source.isDestroyed ? objectIds(source.getJSON()) : new Set<string>()
					const existing = new Set(
						Object.values({
							...latest.regions,
							[latest.regionId]: view.state.doc.toJSON(),
						}).flatMap((document) => Array.from(objectIds(document))),
					)
					const isCut =
						cut &&
						!cut.moved &&
						source &&
						!source.isDestroyed &&
						[...movedIds].every((id) => !existing.has(id) && !sourceIds.has(id))
					const document = view.state.schema.nodeFromJSON(
						isCut ? result.value : copyTypstDocumentNode(result.value, view.state.doc, true),
					)
					const before = view.state.doc
					view.dispatch(
						closeHistory(view.state.tr)
							.replaceSelection(new Slice(document.content, 0, 0))
							.setMeta('paste', true)
							.setMeta('uiEvent', 'paste')
							.scrollIntoView(),
					)
					if (isCut && view.state.doc !== before) cut.moved = true
					return true
				},
				handleKeyDown: (view, event) => {
					if (
						!['Backspace', 'Delete'].includes(event.key) ||
						event.isComposing ||
						view.composing ||
						!view.editable ||
						latestProps.current.editable === false
					)
						return false
					const selection = view.state.selection
					if (
						!(selection instanceof NodeSelection) ||
						selection.$from.parent.type.name !== 'figure'
					)
						return false
					const at = selection.$from.before()
					view.dispatch(
						closeHistory(view.state.tr)
							.setSelection(NodeSelection.create(view.state.doc, at))
							.deleteSelection()
							.scrollIntoView(),
					)
					return true
				},
				handleDrop: (view, event, slice, moved) => {
					if (moved) return false
					let hasIdentity = false
					slice.content.descendants((node) => {
						if (isReferenceObject(node.type.name) || isTypstBlock(node.type.name))
							hasIdentity = true
					})
					if (!hasIdentity) return false
					const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
					if (!coords) return false
					const copied = copyTypstDocumentNode(
						{ type: 'doc', content: slice.content.toJSON() },
						view.state.doc,
						true,
					)
					const next = Slice.fromJSON(view.state.schema, {
						content: copied.content,
						openStart: slice.openStart,
						openEnd: slice.openEnd,
					})
					const at = dropPoint(view.state.doc, coords.pos, next) ?? coords.pos
					view.dispatch(
						closeHistory(view.state.tr)
							.replaceRange(at, at, next)
							.setMeta('uiEvent', 'drop')
							.scrollIntoView(),
					)
					view.focus()
					return true
				},
				attributes: (state) => ({
					role: 'textbox',
					'aria-label': `正文区域 ${props.regionId}`,
					'aria-multiline': 'true',
					'data-typst-region': props.regionId,
					'data-placeholder': latestProps.current.placeholder ?? '输入正文，或键入 / 插入内容…',
					'data-empty':
						state.doc.childCount === 1 &&
						state.doc.firstChild?.type.name === 'paragraph' &&
						state.doc.firstChild.content.size === 0
							? 'true'
							: 'false',
				}),
			},
			onUpdate: ({ editor: current }) => latestProps.current.onChange(current.getJSON()),
			onSelectionUpdate: ({ editor: current, transaction }) => {
				if (transaction.getMeta('typst-navigation')) return
				latestProps.current.onSelection?.(current.state.selection.from)
			},
		},
		[extensions, props.regionId],
	)
	liveEditor.current = editor
	useEffect(() => {
		props.onEditor?.(editor)
		return () => props.onEditor?.(null)
	}, [editor, props.onEditor])
	useEffect(() => {
		editor?.setEditable(props.editable ?? true, false)
	}, [editor, props.editable])
	return (
		<TypstDataProvider data={props.data} fields={props.config.fields}>
			<EditorUi.Provider value={ui}>
				<div
					className={['typst-editor', props.className].filter(Boolean).join(' ')}
					data-readonly={props.editable === false || undefined}
					onCompositionStartCapture={(event) => {
						// Portalled controls own their composition. The document, NodeViews
						// and host controls mounted inside this region share its edit guard.
						if (!event.currentTarget.contains(event.target as Node)) return
						composition.current = true
						setComposing(true)
					}}
					onCompositionEndCapture={(event) => {
						if (!event.currentTarget.contains(event.target as Node)) return
						composition.current = false
						setComposing(false)
					}}
				>
					{issues.length > 0 && !props.onValidationError && (
						<div role="alert" className="typst-editor-error">
							{issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n')}
						</div>
					)}
					{editor && props.toolbar !== false && <TypstEditorToolbar editor={editor} />}
					{editor && props.children?.(editor)}
					<EditorContent editor={editor} className="typst-editor-content" />
					{editor && <EditorMenus editor={editor} />}
				</div>
			</EditorUi.Provider>
		</TypstDataProvider>
	)
}
