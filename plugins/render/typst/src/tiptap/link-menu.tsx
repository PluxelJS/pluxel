import { useContext, useId, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { EditorUi, canEdit } from './editor-ui'
import { prepareLink, safeLink } from './link-actions'
import { shortcutProps } from './shortcuts'

export function LinkMenu({
	editor,
	onApply,
}: {
	editor: Editor
	onApply(transaction: Transaction): boolean
}) {
	const ui = useContext(EditorUi)
	const existing = editor.isActive('link')
	const inserting = editor.state.selection.empty && !existing
	const currentHref = editor.getAttributes('link').href
	const [href, setHref] = useState(typeof currentHref === 'string' ? currentHref : '')
	const [text, setText] = useState('')
	const [error, setError] = useState('')
	const [composing, setComposing] = useState(false)
	const errorId = useId()
	const commit = (change: { href: string; text?: string } | { remove: true }) => {
		const transaction = prepareLink(editor, ui, change)
		if (!transaction) {
			setError(
				'remove' in change
					? '当前选区无法移除链接。'
					: href.length === 0
						? '请输入链接地址。'
						: !safeLink(editor, ui, href)
							? '链接地址不被允许，请使用完整的 https://、http://、mailto:、tel: 地址或文档锚点。'
							: '当前选区或区域不允许此链接。',
			)
			return
		}
		if (!onApply(transaction)) setError('修改未被编辑器接纳，请检查当前区域的编辑规则。')
	}
	return (
		<form
			className="typst-link-form"
			onCompositionStart={() => setComposing(true)}
			onCompositionEnd={() => setComposing(false)}
			onSubmit={(event) => {
				event.preventDefault()
				if (!composing && canEdit(editor, ui)) commit({ href, ...(inserting ? { text } : {}) })
			}}
		>
			<label>
				链接地址
				<input
					type="text"
					inputMode="url"
					autoComplete="off"
					spellCheck={false}
					value={href}
					placeholder="https://example.com"
					aria-invalid={Boolean(error)}
					aria-describedby={error ? errorId : undefined}
					disabled={!canEdit(editor, ui)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing))
							event.preventDefault()
					}}
					onChange={(event) => {
						setHref(event.currentTarget.value)
						setError('')
					}}
				/>
			</label>
			{inserting && (
				<label>
					链接文字
					<input
						type="text"
						value={text}
						placeholder="留空使用链接地址"
						disabled={!canEdit(editor, ui)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing))
								event.preventDefault()
						}}
						onChange={(event) => setText(event.currentTarget.value)}
					/>
				</label>
			)}
			{error && (
				<p id={errorId} role="alert">
					{error}
				</p>
			)}
			<div className="typst-link-actions">
				<button
					type="submit"
					{...shortcutProps('应用链接', 'Enter')}
					disabled={composing || !canEdit(editor, ui)}
				>
					应用链接
				</button>
				{existing && (
					<button
						type="button"
						disabled={composing || !canEdit(editor, ui)}
						onClick={() => commit({ remove: true })}
					>
						移除链接
					</button>
				)}
				{safeLink(editor, ui, href) && (
					<a href={href} target="_blank" rel="noopener noreferrer">
						打开链接
					</a>
				)}
			</div>
		</form>
	)
}
