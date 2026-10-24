import { isTypstBlock, typstBlockPolicy } from './blocks'
import { TypstBlockView } from './blocks-react'
import '@tiptap/extension-text-style'
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Extension, type Editor, type Extensions, type JSONContent } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Slice } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
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
	parseTypstClipboard,
	fieldDisplay,
	type TypstEditorConfig,
	type TypstDataField,
	type TypstEditorIssue,
} from './index'
import { EditorMenus, EditorUi, type TypstSlashCommand } from './ui'
import { FieldData, emptyFields } from './data-context'

export { TypstEditorToolbar, TypstFieldPicker, type TypstSlashCommand } from './ui'
export { TypstBlockPicker } from './blocks-react'
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
				: extension,
	)
}

export interface TypstRegionEditorProps {
	regionId: string
	/** Initial JSON, not a controlled value. Keep config/extensions stable. Change the
	 * document key to load another full draft with fresh history; data/region switches
	 * keep their mounted Editor. onChange reports snapshots for the host to save. */
	content: JSONContent
	config: TypstEditorConfig
	data: unknown
	onChange(content: JSONContent): void
	onEditor?(editor: Editor | null): void
	onSelection?(position: number): void
	/** Reveal a component in the host's current compiled preview. */
	onReveal?(position: number): void
	/** Host controls compose with the native Editor commands. */
	children?: (editor: Editor) => ReactNode
	className?: string
	editable?: boolean
	/** Shown for an empty region; slash insertion remains available without a placeholder. */
	placeholder?: string
	/** Pure native chain composition; do not call run() or dispatch from a command callback. */
	slashCommands?: readonly TypstSlashCommand[]
	onValidationError?(issues: TypstEditorIssue[]): void
}

/** One native Editor/history per region; changing host data does not call setContent. */
export function TypstRegionEditor(props: TypstRegionEditorProps) {
	const config = useMemo(
		() => ({
			...props.config,
			regions: props.config.regions.filter((region) => region.id === props.regionId),
		}),
		[props.config, props.regionId],
	)
	const checked = validateTypstRegions({ regions: { [props.regionId]: props.content }, config })
	if (!checked.ok)
		return <div role="alert">{checked.issues.map((issue) => issue.message).join('\n')}</div>
	return <RegionEditor {...props} config={config} />
}

function RegionEditor(props: TypstRegionEditorProps) {
	const latestProps = useRef(props)
	latestProps.current = props
	const [issues, setIssues] = useState<TypstEditorIssue[]>([])
	const [composing, setComposing] = useState(false)
	const composition = useRef(false)
	const ui = useMemo(
		() => ({
			config: props.config,
			region: props.config.regions.find((region) => region.id === props.regionId),
			editable: props.editable !== false,
			composing,
			onReveal: props.onReveal,
		}),
		[props.config, props.regionId, props.editable, props.onReveal, composing],
	)
	function report(next: TypstEditorIssue[]) {
		setIssues(next)
		if (next.length > 0) latestProps.current.onValidationError?.(next)
	}
	const extensions = useMemo(
		() => [
			...createTypstReactExtensions(props.config),
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
								regions: { [latest.regionId]: transaction.doc.toJSON() },
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
				handlePaste: (view, event) => {
					if (view.state.selection.$from.parent.type.name === 'codeBlock') return false
					const latest = latestProps.current
					const result = parseTypstClipboard({
						html: event.clipboardData?.getData('text/html') || undefined,
						text: event.clipboardData?.getData('text/plain') ?? '',
						regionId: latest.regionId,
						config: latest.config,
					})
					if (!result.ok) {
						report(result.issues)
						return true
					}
					const document = view.state.schema.nodeFromJSON(result.value)
					view.dispatch(
						closeHistory(view.state.tr)
							.replaceSelection(new Slice(document.content, 0, 0))
							.setMeta('paste', true)
							.setMeta('uiEvent', 'paste')
							.scrollIntoView(),
					)
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
					onCompositionStartCapture={() => {
						composition.current = true
						setComposing(true)
					}}
					onCompositionEndCapture={() => {
						composition.current = false
						setComposing(false)
					}}
				>
					{issues.length > 0 && !props.onValidationError && (
						<div role="alert" className="typst-editor-error">
							{issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n')}
						</div>
					)}
					{editor && props.children?.(editor)}
					<EditorContent editor={editor} className="typst-editor-content" />
					{editor && <EditorMenus editor={editor} commands={props.slashCommands} />}
				</div>
			</EditorUi.Provider>
		</TypstDataProvider>
	)
}
