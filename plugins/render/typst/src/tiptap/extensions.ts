import { Extension, Node, flattenExtensions, mergeAttributes, type Extensions } from '@tiptap/core'
import { createEditorExtensions } from './base-extensions.js'
import {
	TypstFigure,
	TypstFigureCaption,
	TypstBlockMath,
	TypstInlineMath,
	TypstReference,
} from './document-nodes.js'
import type { TypstEditorConfig } from './types.js'

export function decodeFieldAttribute(value: string): string {
	return value.replaceAll(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
		const named: Record<string, string> = {
			'&quot;': '"',
			'&apos;': "'",
			'&amp;': '&',
			'&lt;': '<',
			'&gt;': '>',
		}
		if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!
		const code = entity.toLowerCase().startsWith('&#x')
			? Number.parseInt(entity.slice(3, -1), 16)
			: Number.parseInt(entity.slice(2, -1), 10)
		return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
	})
}

export function parseFieldPath(value: string): unknown {
	try {
		return JSON.parse(decodeFieldAttribute(value))
	} catch {
		return value
	}
}

/** Inline atom stores the binding, never a rendered value or mutable data. */
export const DataField = Node.create({
	name: 'dataField',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,
	addAttributes() {
		return {
			path: {
				default: null,
				parseHTML: (element: HTMLElement) => parseFieldPath(element.getAttribute('path') ?? ''),
			},
		}
	},
	parseHTML() {
		return [{ tag: 'data-field[path]' }]
	},
	renderHTML({ node, HTMLAttributes }) {
		return [
			'data-field',
			mergeAttributes(HTMLAttributes, { path: JSON.stringify(node.attrs.path) }),
		]
	},
	markdownTokenName: 'dataField',
	markdownTokenizer: {
		name: 'dataField',
		level: 'inline',
		start: (source: string) => source.indexOf('<data-field'),
		tokenize(source: string) {
			const match = /^<data-field\s+path=(['"])([\s\S]*?)\1\s*>\s*<\/data-field\s*>/i.exec(source)
			if (!match) return undefined
			return { type: 'dataField', raw: match[0], path: parseFieldPath(match[2]!) }
		},
	},
	parseMarkdown(token) {
		return { type: 'dataField', attrs: { path: token.path } }
	},
	renderMarkdown(node) {
		const path = JSON.stringify(node.attrs?.path)
			.replaceAll('&', '&amp;')
			.replaceAll("'", '&#39;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
		return `<data-field path='${path}'></data-field>`
	},
})

// Marked recognizes an unknown HTML tag at the start of a line as an HTML block.
// Keep the controlled inline field in the official paragraph/inline-token path.
const DataFieldMarkdownBlock = Extension.create({
	name: 'typstDataFieldMarkdownBlock',
	markdownTokenName: 'paragraph',
	markdownTokenizer: {
		name: 'typstDataFieldMarkdownBlock',
		level: 'block',
		// Never interrupt an existing paragraph (in particular a backtick code span).
		// The block tokenizer still runs when the lexer starts a new block.
		start: () => -1,
		tokenize(source, _tokens, helpers) {
			const match =
				/^(<data-field\s+path=(['"])[\s\S]*?\2\s*>\s*<\/data-field\s*>[^\n]*)(?:\n|$)/i.exec(source)
			if (!match) return undefined
			return {
				type: 'paragraph',
				raw: match[0],
				text: match[1],
				tokens: helpers.inlineTokens(match[1]!),
			}
		},
	},
})

/** Document semantics share one schema; template/source capabilities remain explicit extensions. */
export function createTypstExtensions(config?: Pick<TypstEditorConfig, 'extensions'>): Extensions {
	const optionalBodies = flattenExtensions(config?.extensions ?? [])
		.filter((extension) => ['templateBlock', 'typstSource'].includes(extension.name))
		.map((extension) => extension.name)
	return [
		...createEditorExtensions(),
		DataField,
		DataFieldMarkdownBlock,
		TypstFigure.extend({
			content: `(${['image', 'table', ...optionalBodies].join(' | ')}) figureCaption`,
		}),
		TypstFigureCaption,
		TypstBlockMath,
		TypstInlineMath,
		TypstReference,
		...(config?.extensions ?? []),
	]
}
