import { Extension, Mark, Node, type Extensions } from '@tiptap/core'
import { createEditorExtensions } from './base-extensions.js'
import { TypstFigure, TypstFigureCaption, TypstReference } from './document-nodes.js'
import { TypstTableStyle } from './table-style.js'

const label = {
	default: null,
	parseHTML: (element: HTMLElement) => element.getAttribute('data-typst-label'),
	renderHTML: (attributes: Record<string, unknown>) =>
		attributes.label ? { 'data-typst-label': attributes.label } : {},
}

export const TypstDocumentFigure = TypstFigure.extend({
	addAttributes: () => ({ label }),
})

function equation(inline: boolean) {
	const kind = inline ? 'inline' : 'block'
	const tag = inline ? 'span' : 'div'
	return Node.create({
		name: inline ? 'inlineMath' : 'blockMath',
		group: kind,
		inline,
		atom: true,
		addAttributes: () => ({
			expression: {
				default: '',
				parseHTML: (element: HTMLElement) => element.getAttribute('data-typst-expression'),
				renderHTML: (attributes: Record<string, unknown>) => ({
					'data-typst-expression': attributes.expression,
				}),
			},
			...(!inline && { label }),
		}),
		parseHTML: () => [{ tag: `${tag}[data-typst-math="${kind}"]` }],
		renderHTML: ({ node, HTMLAttributes }) => [
			tag,
			{ ...HTMLAttributes, 'data-typst-math': kind },
			`$${node.attrs.expression}$`,
		],
		renderText: ({ node }) => `$${node.attrs.expression}$`,
	})
}

export const TypstDocumentInlineMath = equation(true)
export const TypstDocumentBlockMath = equation(false)

const bodyAttributes = Extension.create({
	name: 'typstDocumentAttributes',
	addGlobalAttributes: () => [
		{ types: ['heading'], attributes: { label } },
		{
			types: ['table'],
			attributes: {
				columnWidths: {
					default: null,
					parseHTML: (element: HTMLElement) =>
						element.getAttribute('data-typst-column-widths')?.split(' ') ?? null,
					renderHTML: (attributes: Record<string, unknown>) =>
						Array.isArray(attributes.columnWidths)
							? { 'data-typst-column-widths': attributes.columnWidths.join(' ') }
							: {},
				},
			},
		},
	],
})

const Subscript = Mark.create({
	name: 'subscript',
	excludes: 'superscript',
	parseHTML: () => [{ tag: 'sub' }],
	renderHTML: () => ['sub', 0],
})

const Superscript = Mark.create({
	name: 'superscript',
	excludes: 'subscript',
	parseHTML: () => [{ tag: 'sup' }],
	renderHTML: () => ['sup', 0],
})

/** The same body schema is used by the headless codec and the editor. */
export function createTypstDocumentExtensions(): Extensions {
	return [
		...createEditorExtensions(),
		TypstDocumentFigure,
		TypstFigureCaption,
		TypstDocumentInlineMath,
		TypstDocumentBlockMath,
		TypstReference,
		TypstTableStyle.configure({ allowedStyles: ['grid', 'borderless'] }),
		Subscript,
		Superscript,
		bodyAttributes,
	]
}
