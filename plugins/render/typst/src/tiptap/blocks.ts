import { Node, flattenExtensions, type Extensions, type Command } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection, PluginKey } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
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

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		typstTemplateBlock: {
			/** Create an instance; omitted props are an independent copy of host defaults. */
			insertTypstTemplateBlock: (options: {
				template: string
				props?: TypstJsonObject
				dataPath?: string[]
			}) => ReturnType
			/** Duplicate the instance at a native position, assigning a new ID. */
			duplicateTypstTemplateBlock: (position: number) => ReturnType
		}
		typstSource: {
			/** Source is supplied explicitly by the host, including an empty string. */
			insertTypstSource: (source: string) => ReturnType
			duplicateTypstSource: (position: number) => ReturnType
		}
	}
}

// The React region supplies its latest permission, node rules and composition state.
// A standalone native Editor uses its own editable/composing state.
export const typstBlockPolicy = new PluginKey<(name: string) => boolean>('typst-block-policy')

function instanceId(doc: ProseMirrorNode, commit: boolean): string {
	const ids = new Set<string>()
	doc.descendants((node) => {
		if (isTypstBlock(node.type.name)) ids.add(node.attrs.id)
	})
	let id = commit ? crypto.randomUUID() : 'block-0'
	let index = 0
	while (ids.has(id)) id = commit ? crypto.randomUUID() : `block-${++index}`
	return id
}

function createBlock(name: string, attrs: Record<string, unknown>, position?: number): Command {
	return ({ editor, state, tr, dispatch, commands }) => {
		if (
			!editor.isEditable ||
			editor.view.composing ||
			typstBlockPolicy.getState(state)?.(name) === false
		)
			return false
		const extensions = editor.extensionManager.extensions
		const next = { ...attrs, id: instanceId(tr.doc, !!dispatch) }
		if (blockAttributeError(name, next, extensions)) return false
		// Own every mutable attribute of the new instance, including caller-supplied props.
		const content = { type: name, attrs: structuredClone(next) }
		if (!dispatch) return true
		closeHistory(tr)
		if (position === undefined) return commands.insertContent(content)
		if (!commands.insertContentAt(position, content)) return false
		tr.setSelection(NodeSelection.create(tr.doc, position))
		return true
	}
}

function duplicateBlock(name: string, position: number): Command {
	return (props) => {
		if (!Number.isSafeInteger(position) || position < 0 || position >= props.tr.doc.content.size)
			return false
		const node = props.tr.doc.nodeAt(position)
		if (!node || node.type.name !== name) return false
		if (blockAttributeError(name, node.attrs, props.editor.extensionManager.extensions))
			return false
		return createBlock(name, node.attrs, position + node.nodeSize)(props)
	}
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
	addCommands() {
		return {
			insertTypstTemplateBlock: (options) => (props) => {
				const definition = this.options.templates.find((item) => item.id === options.template)
				if (!definition) return false
				return createBlock(this.name, {
					template: definition.id,
					props: options.props === undefined ? (definition.defaults ?? {}) : options.props,
					dataPath: options.dataPath === undefined ? [] : options.dataPath,
				})(props)
			},
			duplicateTypstTemplateBlock: (position) => duplicateBlock(this.name, position),
		}
	},
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
	addCommands() {
		return {
			insertTypstSource: (source) => createBlock(this.name, { source }),
			duplicateTypstSource: (position) => duplicateBlock(this.name, position),
		}
	},
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
	definitions = templateDefinitions(extensions),
): string | undefined {
	if (!validBlockId(attrs.id)) return 'A Typst block needs a stable alphanumeric instance ID.'
	if (name === 'typstSource') {
		if (typeof attrs.source !== 'string' || !attrs.source.isWellFormed())
			return 'Typst source must be a well-formed string.'
		return undefined
	}
	const definition = definitions.find((item) => item.id === attrs.template)
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
