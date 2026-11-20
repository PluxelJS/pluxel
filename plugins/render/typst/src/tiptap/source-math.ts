import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { closeHistory } from '@tiptap/pm/history'
import { allocateIdentity } from './document-nodes.js'

export const TypstInlineMath = InlineMath

/** Official LaTeX editing and KaTeX view with explicit document identity for block equations. */
export const TypstBlockMath = BlockMath.extend({
	addAttributes() {
		return { ...this.parent?.(), id: { default: null }, label: { default: null } }
	},
	addCommands() {
		const parent = this.parent?.()
		return {
			...parent,
			insertBlockMath: (options) => (props) => {
				if (
					!props.editor.isEditable ||
					props.editor.view.composing ||
					typeof options.latex !== 'string' ||
					!options.latex ||
					!options.latex.isWellFormed()
				)
					return false
				const id = allocateIdentity(props.tr.doc, !!props.dispatch)
				if (props.dispatch) closeHistory(props.tr)
				return props.commands.insertContentAt(options.pos ?? props.state.selection.from, {
					type: this.name,
					attrs: {
						latex: options.latex,
						id,
						...(props.state.schema.nodes[this.name]!.spec.attrs?.label
							? { label: `eq:${id}` }
							: {}),
					},
				})
			},
		}
	},
})
