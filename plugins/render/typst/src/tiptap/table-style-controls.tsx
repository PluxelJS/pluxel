import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { useEditorState } from '@tiptap/react'
import { tableHeaderRows, tableStyleOptions, type TypstTableAppearance } from './table-style'
import { selectedTable } from './table-menu'

const choices = [
	{ value: null, label: '跟随模板' },
	{ value: 'grid', label: '网格' },
	{ value: 'grid-open-sides', label: '网格·无左右框' },
	{ value: 'three-line', label: '三线表' },
	{ value: 'borderless', label: '无边框' },
] as const

function Sample({
	appearance,
	inherited,
}: {
	appearance: TypstTableAppearance
	inherited: boolean
}) {
	return (
		<svg viewBox="0 0 52 30" fill="none" aria-hidden="true" className="typst-table-style-sample">
			<path
				d="M8 7h8m6 0h8m6 0h8M8 15h8m6 0h8m6 0h8M8 23h8m6 0h8m6 0h8"
				stroke="currentColor"
				strokeWidth="2"
				opacity=".3"
			/>
			{appearance !== 'borderless' && (
				<path
					d={
						appearance === 'grid'
							? 'M3 2h46v26H3V2Zm0 9h46M3 19h46M19 2v26M34 2v26'
							: appearance === 'grid-open-sides'
								? 'M3 2h46M3 11h46M3 19h46M3 28h46M19 2v26M34 2v26'
								: 'M3 2h46M3 11h46M3 28h46'
					}
					stroke="currentColor"
					strokeWidth={appearance === 'three-line' ? '1.6' : '1'}
					strokeDasharray={inherited ? '3 2' : undefined}
				/>
			)}
		</svg>
	)
}

/** Optional table properties over the installed extension and native editor commands. */
export function TypstTableStyleControls({
	editor,
	disabled = false,
	onSelect,
}: {
	editor: Editor
	disabled?: boolean
	/** Called after a permitted choice, including reselecting the current appearance. */
	onSelect?(): void
}) {
	const state = useEditorState({
		editor,
		selector: ({ editor: current }) => ({
			selection: current.state.selection,
			document: current.state.doc,
			editable: current.isEditable,
		}),
	})
	const [composing, setComposing] = useState(false)
	useEffect(() => {
		const dom = editor.view.dom
		const start = () => setComposing(true)
		const end = () => setComposing(false)
		dom.addEventListener('compositionstart', start, true)
		dom.addEventListener('compositionend', end, true)
		return () => {
			dom.removeEventListener('compositionstart', start, true)
			dom.removeEventListener('compositionend', end, true)
		}
	}, [editor])
	const options = tableStyleOptions(editor.extensionManager.extensions)
	const table = selectedTable(state.selection)
	if (!options || !table) return null
	const value = table.node.attrs.tableStyle ?? null
	const appearance = value ?? options.defaultStyle ?? 'grid'
	const blocked = disabled || !state.editable || composing || editor.view.composing
	return (
		<div className="typst-table-style-controls" role="group" aria-label="表格样式">
			<span className="typst-table-style-label">表格样式</span>
			<div className="typst-table-style-options">
				{choices.map((choice) => (
					<button
						key={choice.value ?? 'inherit'}
						type="button"
						aria-pressed={value === choice.value}
						disabled={
							blocked || (choice.value !== null && !options.allowedStyles.includes(choice.value))
						}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							const current = selectedTable(editor.state.selection)
							const policy = tableStyleOptions(editor.extensionManager.extensions)
							if (
								disabled ||
								composing ||
								!editor.isEditable ||
								editor.view.composing ||
								!current ||
								!policy ||
								(choice.value !== null && !policy.allowedStyles.includes(choice.value))
							)
								return
							if ((current.node.attrs.tableStyle ?? null) === choice.value) {
								onSelect?.()
								return
							}
							const applied = editor
								.chain()
								.command(({ tr }) => {
									const selection = tr.selection.getBookmark()
									closeHistory(tr)
									tr.setNodeMarkup(current.position, undefined, {
										...current.node.attrs,
										tableStyle: choice.value,
									})
									// Attribute-only changes keep positions, but setNodeMarkup maps NodeSelection away.
									tr.setSelection(selection.resolve(tr.doc))
									return true
								})
								.focus()
								.run()
							if (applied) onSelect?.()
						}}
					>
						<Sample
							appearance={choice.value ?? options.defaultStyle ?? 'grid'}
							inherited={choice.value === null}
						/>
						<span>{choice.label}</span>
					</button>
				))}
			</div>
			{appearance === 'three-line' && tableHeaderRows(table.node.toJSON()) === 0 && (
				<span className="typst-table-style-hint">设置表头后显示分隔线</span>
			)}
		</div>
	)
}
