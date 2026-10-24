import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { channelTemplate } from './report-example.mjs'

/** Business form owned by this consumer, composed with the public native Editor. */
export function ChannelParameters({ editor, editable }: { editor: Editor; editable: boolean }) {
	const state = useEditorState({ editor, selector: ({ editor: current }) => current.state })
	const selection = state.selection
	const instances: { id: string; at: number }[] = []
	state.doc.descendants((node, at) => {
		if (node.type.name === 'templateBlock' && node.attrs.template === 'channels')
			instances.push({ id: node.attrs.id, at })
	})
	// Drafts live as long as their native instance, including selection and region changes.
	return instances.map(({ id, at }) => (
		<ChannelTitle
			key={id}
			editor={editor}
			at={at}
			selected={selection instanceof NodeSelection && selection.from === at}
			editable={editable}
		/>
	))
}

function ChannelTitle({
	editor,
	at,
	selected,
	editable,
}: {
	editor: Editor
	at: number
	selected: boolean
	editable: boolean
}) {
	const node = editor.state.doc.nodeAt(at)!
	const stored = node.attrs.props.title as string
	const [title, setTitle] = useState(stored)
	const [error, setError] = useState('')
	const [composing, setComposing] = useState(false)
	useEffect(() => {
		setTitle(stored)
		setError('')
	}, [stored])
	if (!selected) return <span hidden data-typst-unapplied={title !== stored || undefined} />
	return (
		<form
			className="channel-parameters"
			aria-label="渠道组件参数"
			data-typst-unapplied={title !== stored || undefined}
			onCompositionStartCapture={() => setComposing(true)}
			onCompositionEndCapture={() => setComposing(false)}
			onSubmit={(event) => {
				event.preventDefault()
				if (!editable || composing || !editor.isEditable || editor.view.composing) return
				const current = editor.state.doc.nodeAt(at)
				if (!current || current.attrs.id !== node.attrs.id) {
					setError('组件已变化，请重新选择。')
					return
				}
				const props = { ...current.attrs.props, title }
				const valid = channelTemplate.validateProps?.(props)
				if (valid !== undefined && valid !== true) {
					setError(typeof valid === 'string' ? valid : '标题不能为空。')
					return
				}
				editor
					.chain()
					.setNodeSelection(at)
					.command(({ tr }) => {
						closeHistory(tr)
						return true
					})
					.updateAttributes('templateBlock', { props })
					.run()
				setError(
					editor.state.doc.nodeAt(at)?.attrs.props.title === title
						? ''
						: '当前区域拒绝了参数修改。',
				)
			}}
		>
			<strong>渠道收入与目标 · 参数</strong>
			<small>实例 {node.attrs.id} · 数据绑定：完整输入（本组件固定）</small>
			<label>
				标题{' '}
				<input
					aria-label="渠道组件标题"
					value={title}
					readOnly={!editable}
					onChange={(event) => setTitle(event.currentTarget.value)}
				/>
			</label>
			<div className="panel-actions">
				<button type="submit" disabled={!editable || composing || title === stored}>
					确认参数
				</button>
				<button
					type="button"
					onClick={() => {
						setTitle(stored)
						setError('')
					}}
				>
					取消参数修改
				</button>
			</div>
			{!editable && <small>当前只读或正在使用输入法，参数不能提交。</small>}
			{error && <p role="alert">{error}</p>}
		</form>
	)
}
