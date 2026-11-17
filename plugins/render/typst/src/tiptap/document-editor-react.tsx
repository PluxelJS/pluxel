import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EditorContent, ReactNodeViewRenderer } from '@tiptap/react'
import type { Editor, JSONContent } from '@tiptap/core'
import { createTypstDocumentEditor } from './document-editor.js'
import type { TypstDocumentHistory, TypstDocumentReference } from './document-types.js'
import { TypstFigure, TypstBlockMath, TypstInlineMath, TypstReference } from './document-nodes.js'
import {
	TypstFigureView,
	TypstMathView,
	TypstReferenceView,
	createReferenceSuggestion,
} from './document-react.js'
import {
	prepareDocumentCopy,
	preservesDocumentPlaceholders,
	readDocument,
	synchronizeDocument,
} from './document-content.js'
import { EditorUi, type EditorReferenceTarget, type EditorUiContext } from './editor-ui.js'
import { EditorMenus, TypstEditorToolbar } from './ui.js'
import type { TypstSlashCommand } from './insert-commands.js'
import './document-commands.js'

export type { TypstDocumentHistory, TypstDocumentReference } from './document-types.js'

export interface TypstDocumentEditorProps {
	/** Semantic JSON only. The host owns document selection, drafts, transport and revisions. */
	content: JSONContent
	/** Local changes only; an equal content echo preserves the native selection. */
	onChange(document: JSONContent): void
	/** @default true */
	editable?: boolean
	/** @default true */
	toolbar?: boolean
	className?: string
	fontFamilies?: readonly string[]
	slashCommands?: readonly TypstSlashCommand[]
	references?: readonly TypstDocumentReference[]
	/** Omit for local native history. Changing its presence recreates the history owner. */
	history?: TypstDocumentHistory
	onEditor?(editor: Editor | null): void
	onSelection?(position: number): void
	onReveal?(position: number): void
	onReference?(documentId: string, position: number): void
	children?: (editor: Editor) => ReactNode
}

/** The same rich-text tools as the source editor, driven exclusively by semantic documents. */
export function TypstDocumentEditor(props: TypstDocumentEditorProps) {
	const latest = useRef(props)
	latest.current = props
	const [editor, setEditor] = useState<Editor | null>(null)
	const [composing, setComposing] = useState(false)
	const externalHistory = Boolean(props.history)
	const writable = props.editable !== false
	const referenceTargets = useMemo(
		() => () =>
			(latest.current.references ?? []).map((reference): EditorReferenceTarget => ({
				label: reference.id,
				title: reference.title,
				kind: reference.kind,
				location: reference.location,
			})),
		[],
	)
	useEffect(() => {
		const instance = createTypstDocumentEditor({
			element: document.createElement('div'),
			content: latest.current.content,
			editable: latest.current.editable,
			get references() {
				return latest.current.references
			},
			get history() {
				return latest.current.history
			},
			extensions: [
				TypstFigure.extend({ addNodeView: () => ReactNodeViewRenderer(TypstFigureView) }),
				TypstBlockMath.extend({ addNodeView: () => ReactNodeViewRenderer(TypstMathView) }),
				TypstInlineMath.extend({ addNodeView: () => ReactNodeViewRenderer(TypstMathView) }),
				TypstReference.extend({ addNodeView: () => ReactNodeViewRenderer(TypstReferenceView) }),
				createReferenceSuggestion(() => ({
					editable: latest.current.editable,
					referenceTargets,
					documentReferences: true,
				})),
			],
			onChange: (document) => latest.current.onChange(document),
			onSelection: (position) => latest.current.onSelection?.(position),
		})
		setEditor(instance)
		return () => instance.destroy()
	}, [externalHistory, referenceTargets])
	useEffect(() => {
		if (!editor || editor.isDestroyed) return
		latest.current.onEditor?.(editor)
		return () => latest.current.onEditor?.(null)
	}, [editor])
	useEffect(() => {
		if (!editor || editor.isDestroyed || composing || editor.view.composing) return
		synchronizeDocument(editor, props.content)
	}, [editor, props.content, composing])
	useEffect(() => {
		if (editor && !editor.isDestroyed) editor.setEditable(writable, false)
	}, [editor, writable])
	const ui = useMemo<EditorUiContext>(
		() => ({
			composing,
			editable: writable,
			fontFamilies: props.fontFamilies ?? [],
			slashCommands: props.slashCommands ?? [],
			documentReferences: true,
			referenceTargets,
			onReference: props.onReference,
			onReveal: props.onReveal,
			prepareDuplicate: prepareDocumentCopy,
			validateDocument(document) {
				if (!editor) return false
				try {
					return preservesDocumentPlaceholders(
						editor.state.doc,
						readDocument(editor.schema, document),
					)
				} catch {
					return false
				}
			},
		}),
		[
			editor,
			composing,
			writable,
			props.fontFamilies,
			props.slashCommands,
			props.onReference,
			props.onReveal,
			referenceTargets,
		],
	)
	return (
		<EditorUi.Provider value={ui}>
			<div
				className={['typst-editor', props.className].filter(Boolean).join(' ')}
				data-readonly={!writable || undefined}
				onCompositionStartCapture={() => setComposing(true)}
				onCompositionEndCapture={() => setComposing(false)}
			>
				{editor && writable && props.toolbar !== false && <TypstEditorToolbar editor={editor} />}
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
	)
}
