import { createContext } from 'react'
import type { Editor } from '@tiptap/core'
import type { TypstDataField, TypstEditorConfig, TypstRegionDefinition } from './types'
import type { TypstSlashCommand } from './insert-commands'

export interface EditorUiContext {
	onReveal?: (position: number) => void
	config?: TypstEditorConfig
	region?: TypstRegionDefinition
	composing: boolean
	editable: boolean
	fontFamilies: readonly string[]
	slashCommands: readonly TypstSlashCommand[]
}

const emptyFonts: readonly string[] = []
const emptyCommands: readonly TypstSlashCommand[] = []
export const EditorUi = createContext<EditorUiContext>({
	composing: false,
	editable: true,
	fontFamilies: emptyFonts,
	slashCommands: emptyCommands,
})

export type IconName =
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
	| 'rule'
	| 'link'
	| 'clear'
	| 'indent'
	| 'outdent'
	| 'more'

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
	rule: 'M4 12h16',
	link: 'm10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
	clear: 'm14 3 7 7-10 10H6l-4-4L14 3ZM8 10l7 7m-4 3h10',
	indent: 'M11 5h10M11 10h10M11 15h10M3 20h18M3 6l4 4-4 4',
	outdent: 'M11 5h10M11 10h10M11 15h10M3 20h18M7 6l-4 4 4 4',
	more: 'M5 12h.01M12 12h.01M19 12h.01',
}

export function Icon({ name }: { name: IconName }) {
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

export function allowedNode(ui: EditorUiContext, editor: Editor, ...names: string[]) {
	return names.every(
		(name) => editor.schema.nodes[name] && (!ui.region?.nodes || ui.region.nodes.includes(name)),
	)
}

export function allowedMark(ui: EditorUiContext, editor: Editor, name: string) {
	return Boolean(editor.schema.marks[name]) && (!ui.region?.marks || ui.region.marks.includes(name))
}

export function canEdit(editor: Editor, ui: EditorUiContext) {
	return (
		!editor.view.isDestroyed &&
		ui.editable &&
		editor.isEditable &&
		!ui.composing &&
		!editor.view.composing
	)
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

export function ToolButton({
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
