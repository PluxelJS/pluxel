import { createRoot } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import type { JSONContent, TypstEditorConfig, TypstEditorIssue } from '@pluxel/plugin-typst/tiptap'
import { TypstRegionEditor } from '@pluxel/plugin-typst/tiptap/react'
import '@pluxel/plugin-typst/tiptap/style.css'

const config: TypstEditorConfig = {
	regions: [{ id: 'body' }, { id: 'notes' }],
	fields: [{ path: ['name'], label: 'Name' }],
	extensions: [],
}
const initialContent: JSONContent = {
	type: 'doc',
	content: [
		{
			type: 'paragraph',
			content: [
				{ type: 'text', text: 'Initial ' },
				{ type: 'dataField', attrs: { path: ['name'] } },
			],
		},
	],
}
interface FixtureProps {
	documentKey: string
	regionId: string
	content: JSONContent
	config: TypstEditorConfig
	data: unknown
	editable: boolean
	reportErrors: boolean
}
let props: FixtureProps = {
	documentKey: 'initial',
	regionId: 'body',
	content: initialContent,
	config,
	data: { name: 'Ada' },
	editable: true,
	reportErrors: true,
}

export let editor: Editor | null = null
export const instances: Editor[] = []
export const snapshots: JSONContent[] = []
export const issues: TypstEditorIssue[][] = []
export const connections: (number | null)[] = []
const connect = (current: Editor | null) => {
	editor = current
	if (current && !instances.includes(current)) instances.push(current)
	connections.push(current ? instances.indexOf(current) : null)
}
const report = (next: TypstEditorIssue[]) => issues.push(next)
const root = createRoot(document.getElementById('root')!)

/** Exercise ordinary public props; never call setContent to simulate a rerender. */
export function render(update: Partial<FixtureProps> = {}) {
	props = { ...props, ...update }
	root.render(
		<TypstRegionEditor
			key={props.documentKey}
			regionId={props.regionId}
			content={props.content}
			config={props.config}
			data={props.data}
			editable={props.editable}
			onEditor={connect}
			onChange={(snapshot) => snapshots.push(snapshot)}
			onValidationError={props.reportErrors ? report : undefined}
		/>,
	)
}

export function replaceExtensions(content: JSONContent) {
	render({ config: { ...config, extensions: [] }, content })
}

export function unmount() {
	root.unmount()
}

render()
