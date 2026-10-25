import { CommandManager, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { allowedMark, canEdit, type EditorUiContext } from './editor-ui'
import { allowedLink, validateTypstRegions } from './validation'

/** The document policy and native Link URI check both apply to editing and opening links. */
export function safeLink(editor: Editor, ui: EditorUiContext, href: string): boolean {
	return (
		allowedLink(ui.config ?? { regions: [], fields: [] }, href) && editor.can().setLink({ href })
	)
}

/** Prepare against current native selection; the controller closes when that selection changes. */
export function prepareLink(
	editor: Editor,
	ui: EditorUiContext,
	change: { href: string; text?: string } | { remove: true },
): Transaction | undefined {
	if (
		!canEdit(editor, ui) ||
		!allowedMark(ui, editor, 'link') ||
		!(editor.state.selection instanceof TextSelection)
	)
		return undefined
	const existing = editor.isActive('link')
	if ('remove' in change ? !existing : !safeLink(editor, ui, change.href)) return undefined
	const manager = new CommandManager({ editor, state: editor.state })
	let chain = manager.chain().command(({ tr }) => {
		closeHistory(tr)
		return true
	})
	if ('remove' in change) chain = chain.unsetLink()
	else if (editor.state.selection.empty && !existing) {
		chain = chain.insertContent({
			type: 'text',
			text: change.text || change.href,
			marks: [{ type: 'link', attrs: { href: change.href } }],
		})
		// Future typing after a newly inserted link must not silently inherit its destination.
		chain = chain.unsetMark('link')
	} else {
		if (editor.state.selection.empty) chain = chain.extendMarkRange('link')
		chain = chain.setLink({ href: change.href })
	}
	let transaction: Transaction | undefined
	const success = chain
		.command(({ tr }) => {
			transaction = tr
			return true
		})
		.run()
	if (!success || !transaction) return undefined
	if (
		ui.config &&
		ui.region &&
		!validateTypstRegions({
			regions: { [ui.region.id]: transaction.doc.toJSON() },
			config: ui.config,
		}).ok
	)
		return undefined
	return transaction.scrollIntoView()
}
