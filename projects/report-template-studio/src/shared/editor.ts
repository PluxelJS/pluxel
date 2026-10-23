import { Node, mergeAttributes } from '@tiptap/core'
import {
	TypstTableStyle,
	TypstTemplateBlock,
	TypstSource,
	type TypstEditorConfig,
} from '@pluxel/plugin-typst/tiptap'
import type { EditorDescription } from './contracts.js'

/** A consumer-owned business node: its editing structure and Typst output travel together. */
export const StudioNotice = Node.create({
	name: 'notice',
	group: 'block',
	content: 'block+',
	defining: true,
	addAttributes: () => ({
		tone: {
			default: 'info',
			parseHTML: (element: HTMLElement) => element.getAttribute('data-tone') ?? 'info',
		},
	}),
	parseHTML: () => [{ tag: 'aside[data-typst-notice]' }],
	renderHTML: ({ HTMLAttributes }) => {
		const { tone, ...attributes } = HTMLAttributes
		return ['aside', mergeAttributes(attributes, { 'data-typst-notice': '', 'data-tone': tone }), 0]
	},
})

export function studioEditorConfig(
	config: Pick<EditorDescription, 'regions' | 'fields' | 'table' | 'templates' | 'sourceBlocks'>,
): TypstEditorConfig {
	return {
		regions: config.regions,
		fields: config.fields,
		extensions: [
			TypstTableStyle.configure(config.table ?? {}),
			StudioNotice,
			...(config.templates ? [TypstTemplateBlock.configure({ templates: config.templates })] : []),
			...(config.sourceBlocks ? [TypstSource] : []),
		],
		nodeMappings: {
			notice: {
				html: {
					tag: 'aside',
					attributes: ['data-typst-notice', 'data-tone'],
					validateAttributes: (attrs) =>
						attrs['data-tone'] === 'info' || attrs['data-tone'] === 'warning',
				},
				validateAttributes: (attrs) => attrs.tone === 'info' || attrs.tone === 'warning',
				serialize: (node, context) =>
					`#block(fill: ${node.attrs?.tone === 'warning' ? 'rgb("#fff1cc")' : 'rgb("#e8f2ff")'}, inset: 8pt, width: 100%)[${context.children(node)}]\n`,
			},
		},
	}
}
