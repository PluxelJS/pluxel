import { useContext } from 'react'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { TableMap } from '@tiptap/pm/tables'
import { useEditorState } from '@tiptap/react'
import { EditorUi, allowedNode, canEdit } from './editor-ui'
import { openFormatMenu } from './format-menu'
import { selectedTable, tableActions } from './table-menu'

const commonActions = new Set(['增加行', '增加列', '合并单元格', '拆分单元格', '删除行', '删除列'])

/** Context follows the current native table selection, including multi-cell selections. */
export function TableTools({ editor }: { editor: Editor }) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	const table = selectedTable(editor.state.selection)
	if (!table) return null
	const map = TableMap.get(table.node)
	return (
		<div className="typst-table-tools" role="toolbar" aria-label="表格快捷操作">
			<span className="typst-table-tools-size">
				表格 · {map.height} 行 × {map.width} 列
			</span>
			{tableActions(allowedNode(ui, editor, 'tableHeader'))
				.filter((action) => commonActions.has(action.label))
				.map((action) => (
					<button
						key={action.label}
						type="button"
						disabled={!canEdit(editor, ui) || !action.command(editor.can().chain()).run()}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							if (!canEdit(editor, ui) || !selectedTable(editor.state.selection)) return
							action
								.command(
									editor.chain().command(({ tr }) => {
										closeHistory(tr)
										return true
									}),
								)
								.run()
							editor.view.focus()
						}}
					>
						{action.label}
					</button>
				))}
			<button
				type="button"
				aria-label="更多表格操作"
				onMouseDown={(event) => event.preventDefault()}
				disabled={ui.composing || editor.view.composing}
				onClick={(event) => openFormatMenu(editor, event.currentTarget)}
			>
				更多…
			</button>
		</div>
	)
}
