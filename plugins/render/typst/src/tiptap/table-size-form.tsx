import { useContext, useId, useState, type KeyboardEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorUi, allowedNode, canEdit } from './editor-ui'
import { tableEntry, tableSizeLimits, type TableSize } from './insert-commands'

/** The same input form serves explicit, local and slash insertion; its owner keeps the native target. */
export function TableSizeForm({
	editor,
	inputRef,
	onInsert,
	onCancel,
}: {
	editor: Editor
	inputRef: RefObject<HTMLInputElement | null>
	onInsert(size: TableSize): boolean
	onCancel(): void
}) {
	const ui = useContext(EditorUi)
	const headerAllowed = allowedNode(ui, editor, 'tableHeader')
	const [rows, setRows] = useState('3')
	const [cols, setCols] = useState('3')
	const [header, setHeader] = useState(headerAllowed)
	const [error, setError] = useState('')
	const [composing, setComposing] = useState(false)
	const errorId = useId()
	function keydown(event: KeyboardEvent<HTMLElement>) {
		if ((event.nativeEvent.isComposing || composing) && event.key === 'Enter')
			event.preventDefault()
	}
	return (
		<div role="dialog" tabIndex={-1} aria-label="插入表格">
			<form
				className="typst-table-size-form"
				noValidate
				onCompositionStart={() => setComposing(true)}
				onCompositionEnd={() => setComposing(false)}
				onSubmit={(event) => {
					event.preventDefault()
					if (composing || !canEdit(editor, ui)) return
					const size = {
						rows: Number(rows),
						cols: Number(cols),
						withHeaderRow: header && headerAllowed,
					}
					if (!tableEntry(size)) {
						setError(
							`请输入 1–${tableSizeLimits.rows} 的整数行数和 1–${tableSizeLimits.cols} 的整数列数。`,
						)
						return
					}
					if (!onInsert(size)) setError('当前选区或区域不允许插入此表格。')
				}}
			>
				<strong>插入表格</strong>
				<div className="typst-table-size-fields">
					<label>
						行数
						<input
							onKeyDown={keydown}
							ref={inputRef}
							type="number"
							inputMode="numeric"
							min={1}
							max={tableSizeLimits.rows}
							step={1}
							value={rows}
							disabled={!canEdit(editor, ui)}
							aria-invalid={Boolean(error)}
							aria-describedby={error ? errorId : undefined}
							onChange={(event) => {
								setRows(event.currentTarget.value)
								setError('')
							}}
						/>
					</label>
					<label>
						列数
						<input
							onKeyDown={keydown}
							type="number"
							inputMode="numeric"
							min={1}
							max={tableSizeLimits.cols}
							step={1}
							value={cols}
							disabled={!canEdit(editor, ui)}
							aria-invalid={Boolean(error)}
							aria-describedby={error ? errorId : undefined}
							onChange={(event) => {
								setCols(event.currentTarget.value)
								setError('')
							}}
						/>
					</label>
				</div>
				{headerAllowed && (
					<label className="typst-table-size-header">
						<input
							onKeyDown={keydown}
							type="checkbox"
							checked={header}
							disabled={!canEdit(editor, ui)}
							onChange={(event) => setHeader(event.currentTarget.checked)}
						/>
						首行为表头
					</label>
				)}
				<small>
					1–{tableSizeLimits.rows} 行，1–{tableSizeLimits.cols} 列；插入后可继续增删。
				</small>
				{error && (
					<p id={errorId} role="alert">
						{error}
					</p>
				)}
				<div className="typst-table-size-actions">
					<button onKeyDown={keydown} type="button" onClick={onCancel}>
						取消
					</button>
					<button onKeyDown={keydown} type="submit" disabled={composing || !canEdit(editor, ui)}>
						插入表格
					</button>
				</div>
			</form>
		</div>
	)
}
