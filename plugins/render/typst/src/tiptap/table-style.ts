import { Extension, flattenExtensions, type Extensions, type JSONContent } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export type TypstTableAppearance = 'grid' | 'grid-open-sides' | 'three-line' | 'borderless'
export interface TypstTableStyleOptions {
	/** null leaves the Typst template's table rules intact; the editing fallback is a grid. */
	defaultStyle: TypstTableAppearance | null
	/** Explicit user overrides. An empty list locks tables to the template default. */
	allowedStyles: readonly TypstTableAppearance[]
}
const appearances: readonly TypstTableAppearance[] = [
	'grid',
	'grid-open-sides',
	'three-line',
	'borderless',
]
const isAppearance = (value: unknown): value is TypstTableAppearance =>
	appearances.includes(value as TypstTableAppearance)

/** Internal reader: the installed extension owns defaults and policy, never saved JSON. */
export function tableStyleOptions(extensions: Extensions = []): TypstTableStyleOptions | undefined {
	return flattenExtensions(extensions).find((extension) => extension.name === 'typstTableStyle')
		?.options
}

export function tableStyleOptionsError(options: TypstTableStyleOptions): string | undefined {
	if (Object.keys(options).some((key) => !['defaultStyle', 'allowedStyles'].includes(key)))
		return 'Unknown Typst table style option.'
	if (options.defaultStyle !== null && !isAppearance(options.defaultStyle))
		return 'Table defaultStyle must be grid, grid-open-sides, three-line, borderless or null.'
	if (
		!Array.isArray(options.allowedStyles) ||
		options.allowedStyles.some((style) => !isAppearance(style))
	)
		return 'Table allowedStyles must contain grid, grid-open-sides, three-line or borderless.'
	return undefined
}

export function tableStyleError(
	value: unknown,
	options: TypstTableStyleOptions,
): string | undefined {
	if (value === undefined || value === null) return undefined
	if (!isAppearance(value))
		return 'Table style must be grid, grid-open-sides, three-line, borderless or null.'
	if (!options.allowedStyles.includes(value))
		return 'This table style is not allowed by the template.'
	return undefined
}

/** Complete leading header rows. A cell spanning into the body cannot become a repeated header. */
export function tableHeaderRows(node: JSONContent): number {
	let rows = 0
	for (const row of node.content ?? []) {
		if (!row.content?.length || !row.content.every((cell) => cell.type === 'tableHeader')) break
		rows++
	}
	for (let y = 0; y < rows; y++)
		if (node.content![y]!.content!.some((cell) => y + (cell.attrs?.rowspan ?? 1) > rows)) return 0
	return rows
}

function decorations(doc: ProseMirrorNode, options: TypstTableStyleOptions): DecorationSet {
	const result: Decoration[] = []
	doc.descendants((node, position) => {
		if (node.type.name !== 'table') return
		const appearance = node.attrs.typstTableStyle ?? options.defaultStyle ?? 'grid'
		// Official resizable TableView does not apply new renderHTML attributes on update.
		// A node decoration keeps that view and its resize/selection behavior intact.
		result.push(
			Decoration.node(position, position + node.nodeSize, {
				'data-typst-table-appearance': appearance,
			}),
		)
		const headers = tableHeaderRows(node.toJSON())
		const map = appearance === 'grid-open-sides' ? TableMap.get(node) : undefined
		node.forEach((row, rowOffset, y) => {
			row.forEach((cell, cellOffset) => {
				const classes: string[] = []
				if (y < headers && y + cell.attrs.rowspan === headers)
					classes.push('typst-table-header-end')
				if (map) {
					// DOM child order is not column order when a previous row spans into this one.
					const rectangle = map.findCell(rowOffset + cellOffset + 1)
					if (rectangle.left === 0) classes.push('typst-table-edge-left')
					if (rectangle.right === map.width) classes.push('typst-table-edge-right')
				}
				if (classes.length === 0) return
				const from = position + 2 + rowOffset + cellOffset
				result.push(Decoration.node(from, from + cell.nodeSize, { class: classes.join(' ') }))
			})
		})
	})
	return DecorationSet.create(doc, result)
}

/** Optional layout attributes over official TableKit. Removing it removes no table nodes or commands. */
export const TypstTableStyle = Extension.create<TypstTableStyleOptions>({
	name: 'typstTableStyle',
	addOptions: () => ({ defaultStyle: null, allowedStyles: [...appearances] }),
	addGlobalAttributes() {
		return [
			{
				types: ['table'],
				attributes: {
					typstTableStyle: {
						default: null,
						parseHTML: (element: HTMLElement) => {
							const value = element.getAttribute('data-typst-table-style')
							return value === 'inherit' ? null : value
						},
						renderHTML: (attrs: Record<string, unknown>) => ({
							'data-typst-table-style': attrs.typstTableStyle ?? 'inherit',
							'data-typst-table-appearance':
								attrs.typstTableStyle ?? this.options.defaultStyle ?? 'grid',
						}),
					},
				},
			},
		]
	},
	addProseMirrorPlugins() {
		const error = tableStyleOptionsError(this.options)
		if (error) throw new TypeError(error)
		const options = this.options
		return [
			new Plugin<DecorationSet>({
				state: {
					init: (_, state) => decorations(state.doc, options),
					apply: (tr, previous) => (tr.docChanged ? decorations(tr.doc, options) : previous),
				},
				props: {
					decorations(state) {
						return this.getState(state)
					},
				},
				filterTransaction: (tr) => {
					if (!tr.docChanged) return true
					let valid = true
					tr.doc.descendants((node) => {
						if (node.type.name === 'table' && tableStyleError(node.attrs.typstTableStyle, options))
							valid = false
					})
					return valid
				},
			}),
		]
	},
})
