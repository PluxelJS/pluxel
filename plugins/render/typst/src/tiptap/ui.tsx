import { useContext, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { EditorUi, Icon, ToolButton, canEdit } from './editor-ui'
import {
	FormatContextMenu,
	PrimaryFormatTools,
	hasFormatTarget,
	openFormatMenu,
} from './format-menu'
import { InsertMenu, SlashMenu } from './insert-menu'
import { BlockMenu } from './block-menu'

/** Common commands stay visible; the same native selection drives the full format menu. */
export function TypstEditorToolbar({ editor, children }: { editor: Editor; children?: ReactNode }) {
	useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const ui = useContext(EditorUi)
	return (
		<div className="typst-toolbars">
			<div role="toolbar" aria-label="正文格式" className="typst-toolbar">
				<div className="typst-tool-group">
					<ToolButton
						label="撤销"
						icon="undo"
						disabled={!canEdit(editor, ui) || !editor.can().undo()}
						onClick={() => {
							if (canEdit(editor, ui)) {
								editor.commands.undo()
								editor.view.focus()
							}
						}}
					/>
					<ToolButton
						label="重做"
						icon="redo"
						disabled={!canEdit(editor, ui) || !editor.can().redo()}
						onClick={() => {
							if (canEdit(editor, ui)) {
								editor.commands.redo()
								editor.view.focus()
							}
						}}
					/>
				</div>
				<PrimaryFormatTools editor={editor} />
				<div className="typst-tool-group">
					<button
						type="button"
						className="typst-tool-button typst-format-trigger"
						aria-label="格式"
						title="更多格式（字体、字号、颜色等）"
						aria-haspopup="dialog"
						disabled={!canEdit(editor, ui) || !hasFormatTarget(editor)}
						onMouseDown={(event) => event.preventDefault()}
						onClick={(event) => {
							if (canEdit(editor, ui)) openFormatMenu(editor, event.currentTarget)
						}}
					>
						<Icon name="more" />
					</button>
					<InsertMenu editor={editor} />
				</div>
				{children && <div className="typst-tool-group typst-tool-group-custom">{children}</div>}
			</div>
			{!canEdit(editor, ui) && (
				<small className="typst-editing-reason">
					{ui.composing
						? '输入法编辑中，结构和格式操作暂不可用'
						: '当前区域只读，格式和插入操作不可用'}
				</small>
			)}
		</div>
	)
}

export function EditorMenus({ editor }: { editor: Editor }) {
	return (
		<>
			<BlockMenu editor={editor} />
			<FormatContextMenu editor={editor} />
			<SlashMenu editor={editor} />
		</>
	)
}
