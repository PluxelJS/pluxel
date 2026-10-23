import { Node, flattenExtensions, type Extensions } from '@tiptap/core'
import type { TypstJsonObject } from './types.js'

/** Host-owned markup; data and props are available as local Typst variables. */
export interface TypstTemplateDefinition {
	id: string
	label: string
	source: string
	defaults?: TypstJsonObject
	validateProps?: (props: TypstJsonObject) => boolean | string
}
export interface TypstTemplateBlockOptions {
	templates: readonly TypstTemplateDefinition[]
}

/** An explicitly installed atom, independent of ordinary TableKit and Markdown nodes. */
export const TypstTemplateBlock = Node.create<TypstTemplateBlockOptions>({
	name: 'templateBlock',
	group: 'block',
	atom: true,
	draggable: true,
	selectable: true,
	addOptions: () => ({ templates: [] }),
	addAttributes: () => ({
		id: { default: null },
		template: { default: null },
		props: { default: {} },
		dataPath: { default: [] },
	}),
	// Clipboard cannot silently flatten a generated component into editable HTML.
	renderHTML: ({ node }) => [
		'typst-template-block',
		{ 'data-id': node.attrs.id },
		node.attrs.template,
	],
	renderText: ({ node }) => `[${node.attrs.template}]`,
	renderMarkdown: (node) => `[Template: ${node.attrs?.template}]`,
})

/** Installing this extension explicitly grants source authoring within the host's compiler policy. */
export const TypstSource = Node.create({
	name: 'typstSource',
	group: 'block',
	atom: true,
	draggable: true,
	selectable: true,
	addAttributes: () => ({ id: { default: null }, source: { default: '' } }),
	renderHTML: ({ node }) => ['typst-source', { 'data-id': node.attrs.id }, node.attrs.source],
	renderText: ({ node }) => node.attrs.source,
	renderMarkdown: (node) => {
		const source = (node.attrs?.source ?? '') as string
		const runs = [...source.matchAll(/`+/g)].map((match) => match[0].length)
		const fence = '`'.repeat(Math.max(3, ...runs.map((length) => length + 1)))
		// This export is a literal code example, never executable Markdown intake.
		return `${fence}typst\n${source}\n${fence}`
	},
})

export const isTypstBlock = (name: string) => name === 'templateBlock' || name === 'typstSource'
export const validBlockId = (id: unknown): id is string =>
	typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)

export function templateDefinitions(
	extensions: Extensions = [],
): readonly TypstTemplateDefinition[] {
	return (
		flattenExtensions(extensions).find((extension) => extension.name === 'templateBlock')?.options
			.templates ?? []
	)
}

export function templateDefinitionError(extensions: Extensions): string | undefined {
	const block = flattenExtensions(extensions).find(
		(extension) => extension.name === 'templateBlock',
	)
	if (!block) return undefined
	if (
		Object.keys(block.options).some((key) => key !== 'templates') ||
		!Array.isArray(block.options.templates)
	)
		return 'TemplateBlock requires a templates array.'
	const ids = new Set<string>()
	for (const definition of block.options.templates) {
		if (
			!definition ||
			!validBlockId(definition.id) ||
			ids.has(definition.id) ||
			typeof definition.label !== 'string' ||
			!definition.label ||
			typeof definition.source !== 'string' ||
			!definition.source.trim() ||
			!definition.source.isWellFormed() ||
			(definition.validateProps !== undefined && typeof definition.validateProps !== 'function') ||
			(definition.defaults !== undefined && !jsonObject(definition.defaults))
		)
			return 'Template definitions require unique IDs, labels, source, JSON object defaults and an optional property validator.'
		ids.add(definition.id)
		const defaults = definition.validateProps?.(definition.defaults ?? {})
		if (defaults !== undefined && defaults !== true)
			return typeof defaults === 'string' ? defaults : 'Invalid template defaults.'
	}
	return undefined
}

function jsonObject(value: unknown): value is TypstJsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const seen = new Set<object>()
	const visit = (item: unknown): boolean => {
		if (item === null || typeof item === 'boolean') return true
		if (typeof item === 'string') return item.isWellFormed()
		if (typeof item === 'number') return Number.isFinite(item)
		if (!item || typeof item !== 'object' || seen.has(item)) return false
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
			return false
		seen.add(item)
		const valid = Object.entries(item).every(([key, child]) => key.isWellFormed() && visit(child))
		seen.delete(item)
		return valid
	}
	return visit(value)
}

export function blockAttributeError(
	name: string,
	attrs: Record<string, unknown>,
	extensions: Extensions = [],
	data?: unknown,
): string | undefined {
	if (!validBlockId(attrs.id)) return 'A Typst block needs a stable alphanumeric instance ID.'
	if (name === 'typstSource') {
		if (typeof attrs.source !== 'string' || !attrs.source.isWellFormed())
			return 'Typst source must be a well-formed string.'
		return undefined
	}
	const definition = templateDefinitions(extensions).find((item) => item.id === attrs.template)
	if (!definition) return 'This template component is not registered by the host.'
	if (!jsonObject(attrs.props)) return 'Template properties must be a JSON object.'
	const valid = definition.validateProps?.(attrs.props)
	if (valid !== undefined && valid !== true)
		return typeof valid === 'string' ? valid : 'Invalid template properties.'
	if (
		!Array.isArray(attrs.dataPath) ||
		attrs.dataPath.some((part) => typeof part !== 'string' || !part.isWellFormed())
	)
		return 'Template dataPath must be a string array; [] binds the full parsed input.'
	if (data !== undefined) {
		let bound: unknown = data
		for (const part of attrs.dataPath) {
			if (bound === null || typeof bound !== 'object' || !Object.hasOwn(bound, part))
				return 'The template data binding does not exist in the parsed input.'
			bound = (bound as Record<string, unknown>)[part]
		}
	}
	return undefined
}
