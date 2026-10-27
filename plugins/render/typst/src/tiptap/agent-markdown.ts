import {
	Extension,
	flattenExtensions,
	type Extensions,
	type JSONContent,
	type MarkdownToken,
	type Node,
} from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { MarkdownManager } from '@tiptap/markdown'
import { TextStyle, TextStyleKit } from '@tiptap/extension-text-style'
import { createTypstExtensions, DataField } from './extensions.js'
import { isolatedMarked } from './base-extensions.js'
import { textStyleAttributes, validTextStyleValue } from './text-style.js'
import type { TypstEditorConfig } from './types.js'

type AgentToken = MarkdownToken & {
	agentError?: string
	agentSource?: string
	attributes?: Record<string, unknown>
}

function failure(type: string, raw: string, agentError: string): AgentToken {
	return { type, raw, agentError }
}

/** Read the JSON object before the shortcode's closing bracket, including arrays
 * and brackets inside JSON strings. JSON values retain their original meaning. */
function opening(source: string, name: string): AgentToken | undefined {
	const prefix = `[${name}`
	if (!source.startsWith(prefix) || !/^(?:[\s\]]|$)/.test(source.slice(prefix.length)))
		return undefined
	let quoted = false
	let stringStart = 0
	let depth = 0
	let end = -1
	const names = new Set<string>()
	let duplicate = false
	for (let index = prefix.length; index < source.length; index++) {
		const character = source[index]!
		if (quoted) {
			if (character === '\\') index++
			else if (character === '"') {
				quoted = false
				if (depth === 1 && /^\s*:/.test(source.slice(index + 1))) {
					let key: string
					try {
						key = JSON.parse(source.slice(stringStart, index + 1))
					} catch {
						return failure(name, source, `${name} attributes must be a JSON object.`)
					}
					if (names.has(key)) duplicate = true
					names.add(key)
				}
			}
			continue
		}
		if (character === '"') {
			quoted = true
			stringStart = index
		} else if (character === '[' || character === '{') depth++
		else if (character === ']' && depth === 0) {
			end = index
			break
		} else if (character === ']' || character === '}') depth--
	}
	if (end < 0) return failure(name, source, `Unclosed ${name} shortcode.`)
	const raw = source.slice(0, end + 1)
	const json = source.slice(prefix.length, end).trim()
	let attributes: unknown
	try {
		attributes = JSON.parse(json)
	} catch {
		return failure(name, raw, `${name} attributes must be a JSON object.`)
	}
	if (name === 'marks') {
		if (!Array.isArray(attributes)) return failure(name, raw, 'Marks must be a JSON array.')
		return { type: name, raw, agentSource: json }
	}
	if (name === 'tiptap') {
		const checked = nativeNode(json)
		return 'error' in checked
			? failure(name, raw, checked.error)
			: { type: name, raw, agentSource: json }
	}
	if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes))
		return failure(name, raw, `${name} attributes must be a JSON object.`)
	if (duplicate) return failure(name, raw, `Duplicate ${name} attribute.`)
	const allowed: readonly string[] =
		name === 'textStyle'
			? textStyleAttributes
			: name === 'ref'
				? ['target', 'showCaption']
				: ['path']
	if (Object.keys(attributes).some((key) => !allowed.includes(key)))
		return failure(name, raw, `Unsupported ${name} attribute.`)
	if (name === 'textStyle')
		for (const attribute of textStyleAttributes)
			if (
				Object.hasOwn(attributes, attribute) &&
				!validTextStyleValue(attribute, (attributes as Record<string, unknown>)[attribute])
			)
				return failure(name, raw, `Invalid portable ${attribute} value.`)
	return { type: name, raw, attributes: attributes as Record<string, unknown> }
}

/** A backtick starts code only when a later run has exactly the same length. */
function codeEnd(source: string, start: number): number {
	let length = 1
	while (source[start + length] === '`') length++
	const runs = /`+/g
	runs.lastIndex = start + length
	for (let match = runs.exec(source); match; match = runs.exec(source))
		if (match[0].length === length) return match.index + length
	return start + length
}

function spanEnd(source: string, start: number, name: string): { end: number; error?: string } {
	for (let index = start; index < source.length; index++) {
		if (source[index] === '\\') {
			index++
			continue
		}
		if (source[index] === '`') {
			index = codeEnd(source, index) - 1
			continue
		}
		if (source.startsWith(`[/${name}]`, index)) return { end: index }
		if (
			source.startsWith(`[${name}`, index) &&
			/^[\s\]]/.test(source[index + name.length + 1] ?? '')
		)
			return { end: index, error: `Nested ${name} shortcodes are not supported.` }
		// A field path or literal native node can itself contain closing-marker text.
		for (const atom of source[index] === '[' ? ['dataField', 'tiptap'] : []) {
			const token = opening(source.slice(index), atom)
			if (token && !token.agentError) {
				index += token.raw!.length - 1
				break
			}
		}
	}
	return { end: source.length, error: `Unclosed ${name} shortcode.` }
}

const AgentTextStyle = TextStyle.extend({
	markdownTokenizer: {
		name: 'textStyle',
		level: 'inline',
		start: (source) => source.search(/\[(?:textStyle(?=[\s\]]|$)|\/textStyle\])/),
		tokenize(source, _tokens, lexer) {
			if (source.startsWith('[/textStyle]'))
				return failure('textStyle', '[/textStyle]', 'Unexpected closing textStyle shortcode.')
			const token = opening(source, 'textStyle')
			if (!token || token.agentError) return token
			const start = token.raw!.length
			const closing = spanEnd(source, start, 'textStyle')
			if (closing.error) return failure('textStyle', source, closing.error)
			return {
				...token,
				raw: source.slice(0, closing.end + '[/textStyle]'.length),
				tokens: lexer.inlineTokens(source.slice(start, closing.end)),
			}
		},
	},
	parseMarkdown(token, helpers) {
		// The public intake checks agentError before invoking this parser. Retain
		// malformed text if a native MarkdownManager is used without that admission.
		if (token.agentError) return helpers.createTextNode(token.raw ?? '')
		const content = helpers.parseInline(token.tokens ?? [])
		// applyMark only visits text in the upstream helper. Inline atoms such as
		// dataField also carry native marks, so preserve their styling here.
		for (const node of content)
			node.marks = [...(node.marks ?? []), { type: 'textStyle', attrs: token.attributes }]
		return content
	},
	renderMarkdown(node, helpers) {
		const attributes = Object.fromEntries(
			Object.entries(node.attrs ?? {}).filter(([, value]) => value !== null && value !== undefined),
		)
		return `[textStyle ${JSON.stringify(attributes)}]${helpers.renderChildren(node.content ?? [])}[/textStyle]`
	},
})

const AgentDataField = DataField.extend({
	markdownTokenizer: {
		name: 'dataField',
		level: 'inline',
		start: (source) => source.search(/\[dataField(?=[\s\]]|$)/),
		tokenize: (source) => opening(source, 'dataField'),
	},
	parseMarkdown(token, helpers) {
		return token.agentError
			? helpers.createTextNode(token.raw ?? '')
			: { type: 'dataField', attrs: token.attributes }
	},
	renderMarkdown: (node) => `[dataField ${JSON.stringify(node.attrs ?? {})}]`,
})

function nativeNode(source: string): { node: JSONContent } | { error: string } {
	let node: unknown
	try {
		node = JSON.parse(source)
	} catch {
		return { error: 'The tiptap block must contain a JSON node or document.' }
	}
	if (!node || typeof node !== 'object' || Array.isArray(node))
		return { error: 'The tiptap block must contain a JSON node or document.' }
	const value = node as JSONContent
	if (typeof value.type !== 'string') return { error: 'The tiptap JSON node needs a type.' }
	if (
		value.type === 'doc' &&
		(Object.keys(value).some((key) => key !== 'type' && key !== 'content') ||
			!Array.isArray(value.content) ||
			value.content.length === 0)
	)
		return { error: 'A tiptap document wrapper accepts only type and a nonempty content array.' }
	return { node: value }
}

const AgentTiptapNode = Extension.create({
	name: 'agentTiptapNode',
	markdownTokenName: 'agentTiptapNode',
	markdownTokenizer: {
		name: 'agentTiptapNode',
		level: 'block',
		// Only recognize a new block; never split an existing paragraph/code span.
		start: () => -1,
		tokenize(source) {
			if (!/^ {0,3}:::tiptap(?=\s|$)/.test(source)) return undefined
			const header = /^ {0,3}:::tiptap[\t ]*\r?\n/.exec(source)
			if (!header)
				return failure('agentTiptapNode', source, 'A tiptap block needs its own opening line.')
			const remainder = source.slice(header[0].length)
			const closing = /^ {0,3}:::[\t ]*(?:\r?\n|$)/m.exec(remainder)
			if (!closing) return failure('agentTiptapNode', source, 'Unclosed tiptap block.')
			const agentSource = remainder.slice(0, closing.index)
			const raw = source.slice(0, header[0].length + closing.index + closing[0].length)
			const checked = nativeNode(agentSource)
			if ('error' in checked) return failure('agentTiptapNode', raw, checked.error)
			// Keep payload opaque to token admission. It may legally contain props
			// whose keys happen to look like Markdown lexer tokens.
			return { type: 'agentTiptapNode', raw, agentSource }
		},
	},
	parseMarkdown(token) {
		const checked = nativeNode(token.agentSource ?? '')
		if ('error' in checked) return { type: 'paragraph', content: [] }
		// An array keeps MarkdownManager from interpreting an invalid native
		// object's `mark` key as its own parser-result protocol before validation.
		return checked.node.type === 'doc' ? checked.node.content! : [checked.node]
	},
})

const AgentMarks = Extension.create({
	name: 'agentMarks',
	markdownTokenName: 'agentMarks',
	markdownTokenizer: {
		name: 'agentMarks',
		level: 'inline',
		start: (source) => source.search(/\[(?:marks(?=[\s\]]|$)|\/marks\])/),
		tokenize(source, _tokens, lexer) {
			if (source.startsWith('[/marks]'))
				return failure('agentMarks', '[/marks]', 'Unexpected closing marks shortcode.')
			const token = opening(source, 'marks')
			if (!token) return undefined
			if (token.agentError) return { ...token, type: 'agentMarks' }
			const start = token.raw!.length
			const closing = spanEnd(source, start, 'marks')
			if (closing.error) return failure('agentMarks', source, closing.error)
			if (closing.end === start)
				return failure('agentMarks', source, 'A marks span needs inline content.')
			return {
				...token,
				type: 'agentMarks',
				raw: source.slice(0, closing.end + '[/marks]'.length),
				tokens: lexer.inlineTokens(source.slice(start, closing.end)),
			}
		},
	},
	parseMarkdown(token, helpers) {
		const content = helpers.parseInline(token.tokens ?? [])
		const marks = JSON.parse(token.agentSource ?? '[]')
		for (const node of content) node.marks = [...(node.marks ?? []), ...marks]
		return content
	},
})

const AgentInlineNode = Extension.create({
	name: 'agentInlineNode',
	markdownTokenName: 'agentInlineNode',
	markdownTokenizer: {
		name: 'agentInlineNode',
		level: 'inline',
		start: (source) => source.search(/\[tiptap(?=[\s\]]|$)/),
		tokenize(source) {
			const token = opening(source, 'tiptap')
			return token ? { ...token, type: 'agentInlineNode' } : undefined
		},
	},
	parseMarkdown(token) {
		const checked = nativeNode(token.agentSource ?? '')
		return 'error' in checked ? [] : [checked.node]
	},
})

const AgentReference = Extension.create({
	name: 'agentReference',
	markdownTokenName: 'agentReference',
	markdownTokenizer: {
		name: 'agentReference',
		level: 'inline',
		start: (source) => source.search(/\[ref(?=[\s\]]|$)/),
		tokenize(source) {
			const token = opening(source, 'ref')
			return token ? { ...token, type: 'agentReference' } : undefined
		},
	},
	parseMarkdown(token) {
		return { type: 'reference', attrs: token.attributes }
	},
})

/** Figures retain editable Markdown for both their body and their separate caption. */
function figureBlock(name: 'figure' | 'caption') {
	return Extension.create({
		name: `agent${name}`,
		markdownTokenName: `agent${name}`,
		markdownTokenizer: {
			name: `agent${name}`,
			level: 'block',
			start: () => -1,
			tokenize(source, _tokens, lexer) {
				if (!new RegExp(`^ {0,3}:{3,}${name}(?=\\s|$)`).test(source)) return undefined
				const header = new RegExp(`^ {0,3}(:{3,})${name}([\\t ][^\\r\\n]*)?\\r?\\n`).exec(source)
				if (!header) return failure(`agent${name}`, source, `Invalid ${name} opening line.`)
				let attributes: unknown = {}
				try {
					if (header[2]?.trim()) attributes = JSON.parse(header[2])
				} catch {
					return failure(`agent${name}`, source, `Invalid ${name} attributes.`)
				}
				if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes))
					return failure(`agent${name}`, source, `${name} attributes must be an object.`)
				if (name === 'caption' && Object.keys(attributes).length > 0)
					return failure(
						`agent${name}`,
						source,
						'Caption formatting belongs to its inline content.',
					)
				const rest = source.slice(header[0].length)
				const closing = new RegExp(`^ {0,3}${header[1]}[\\t ]*(?:\\r?\\n|$)`, 'm').exec(rest)
				if (!closing) return failure(`agent${name}`, source, `Unclosed ${name} block.`)
				const raw = source.slice(0, header[0].length + closing.index + closing[0].length)
				const tokens = lexer
					.blockTokens(rest.slice(0, closing.index))
					.filter((token) => token.type !== 'space')
				return { type: `agent${name}`, raw, attributes, tokens }
			},
		},
		parseMarkdown(token, helpers) {
			const children = helpers.parseChildren(token.tokens ?? [])
			if (name === 'figure') return { type: 'figure', attrs: token.attributes, content: children }
			if (children.length === 0) return { type: 'figureCaption' }
			if (children.length !== 1 || children[0]?.type !== 'paragraph')
				return { type: 'agentInvalidCaption' }
			return { type: 'figureCaption', content: children[0].content }
		},
	})
}

function fencedBlock(name: string, body: string, attributes?: Record<string, unknown>): string {
	const runs = [...body.matchAll(/^\s*(:{3,})/gm)].map((match) => match[1]!.length)
	const fence = ':'.repeat(Math.max(3, ...runs.map((length) => length + 1)))
	return `${fence}${name}${attributes ? ` ${JSON.stringify(attributes)}` : ''}\n${body}\n${fence}`
}

const AgentAttributes = Extension.create({
	name: 'agentAttributes',
	markdownTokenName: 'agentAttributes',
	markdownTokenizer: {
		name: 'agentAttributes',
		level: 'block',
		start: () => -1,
		tokenize(source, _tokens, lexer) {
			if (!/^ {0,3}:{3,}attrs(?=\s|$)/.test(source)) return undefined
			const header = /^ {0,3}(:{3,})attrs[\t ]+([^\r\n]+)\r?\n/.exec(source)
			if (!header)
				return failure(
					'agentAttributes',
					source,
					'An attrs block needs a JSON object on its opening line.',
				)
			let attributes: unknown
			try {
				attributes = JSON.parse(header[2]!)
			} catch {
				return failure('agentAttributes', source, 'Invalid attrs JSON object.')
			}
			if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes))
				return failure('agentAttributes', source, 'Block attributes must be a JSON object.')
			const remainder = source.slice(header[0].length)
			const closing = new RegExp(`^ {0,3}${header[1]}[\\t ]*(?:\\r?\\n|$)`, 'm').exec(remainder)
			if (!closing) return failure('agentAttributes', source, 'Unclosed attrs block.')
			const raw = source.slice(0, header[0].length + closing.index + closing[0].length)
			const tokens = lexer
				.blockTokens(remainder.slice(0, closing.index))
				.filter((token) => token.type !== 'space')
				.map((token) => {
					if (token.type === 'text' && token.tokens) token.type = 'paragraph'
					return token
				})
			if (tokens.length !== 1)
				return failure(
					'agentAttributes',
					raw,
					'An attrs block must contain exactly one Markdown block.',
				)
			return { type: 'agentAttributes', raw, agentSource: header[2], tokens }
		},
	},
	parseMarkdown(token, helpers) {
		const content = helpers.parseChildren(token.tokens ?? [])
		if (content.length !== 1) return [{ type: 'agentInvalidAttributeBlock' }]
		const node = content[0]!
		return [{ ...node, attrs: { ...node.attrs, ...JSON.parse(token.agentSource ?? '{}') } }]
	},
})

function attributeBlock(attributes: Record<string, unknown>, body: string): string {
	return fencedBlock('attrs', body, attributes)
}

function reservedBlockText(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return value.some(reservedBlockText)
	const token = value as AgentToken
	if (token.type === 'code' || token.type === 'codespan') return false
	if (
		token.type === 'text' &&
		!token.tokens &&
		/^ {0,3}:{3,}(?:tiptap|attrs|figure|caption)(?=\s|$)/m.test(token.raw ?? '')
	)
		return true
	return Object.values(token).some(reservedBlockText)
}

/** Agent input uses the same native schema and official Markdown inline rules. */
export function createAgentMarkdownExtensions(config: TypstEditorConfig): Extensions {
	return flattenExtensions(
		createTypstExtensions(config)
			.filter((extension) => extension.name !== 'typstDataFieldMarkdownBlock')
			.flatMap((extension) => {
				if (extension.name === 'textStyleKit')
					return [
						TextStyleKit.configure({ ...extension.options, textStyle: false }),
						AgentTextStyle,
					]
				if (extension.name === 'dataField') return [AgentDataField]
				return [extension]
			}),
	)
		.map((extension) =>
			extension.name === 'listItem'
				? (extension as Node).extend({
						addExtensions: () => [],
						parseMarkdown(token, helpers) {
							// Marked uses block-level `text` after custom blocks inside list items.
							// Give those tokens their block context before the official list parser.
							return this.parent!(
								{
									...token,
									tokens: token.tokens?.map((child) =>
										child.type === 'text' && child.tokens ? { ...child, type: 'paragraph' } : child,
									),
								},
								helpers,
							)
						},
					})
				: extension.extend({ addExtensions: () => [] }),
		)
		.concat(
			AgentTiptapNode,
			AgentMarks,
			AgentInlineNode,
			AgentAttributes,
			AgentReference,
			figureBlock('figure'),
			figureBlock('caption'),
		)
}

/** A complete native subtree; only the public intake grants it document semantics. */
export function agentNodeMarkdown(node: JSONContent): string {
	return `:::tiptap\n${JSON.stringify(node)}\n:::`
}

/** Recursive projection. Native fallback belongs to the smallest unsupported
 * subtree; a document is never replaced by one opaque JSON payload. */
export class AgentMarkdownManager extends MarkdownManager {
	constructor(
		config: TypstEditorConfig,
		private readonly schema: Schema,
	) {
		super({
			extensions: createAgentMarkdownExtensions(config),
			marked: isolatedMarked(),
			markedOptions: { gfm: true, breaks: false },
		})
	}

	private same(a: JSONContent, b: JSONContent): boolean {
		try {
			return this.schema.nodeFromJSON(a).eq(this.schema.nodeFromJSON(b))
		} catch {
			return false
		}
	}

	private inlineMatches(nodes: JSONContent[], source: string): boolean {
		const parsed = this.parse(`[textStyle {}]${source}[/textStyle]`).content
		if (parsed?.length !== 1 || parsed[0]?.type !== 'paragraph') return false
		const content = parsed[0].content
		for (const node of content ?? [])
			node.marks = node.marks?.filter((mark) => mark.type !== 'textStyle')
		return this.same({ type: 'paragraph', content: nodes }, { type: 'paragraph', content })
	}

	private inline(nodes: JSONContent[], parent: JSONContent, level: number): string {
		const groups: { style: JSONContent['attrs']; nodes: JSONContent[] }[] = []
		for (const node of nodes) {
			const style = node.marks?.find((mark) => mark.type === 'textStyle')?.attrs
			const plain = { ...node, marks: node.marks?.filter((mark) => mark.type !== 'textStyle') }
			const previous = groups.at(-1)
			if (previous && JSON.stringify(previous.style) === JSON.stringify(style))
				previous.nodes.push(plain)
			else groups.push({ style, nodes: [plain] })
		}
		return groups
			.map((group) => {
				let source = super.renderNodes(group.nodes, parent, '', 0, level)
				if (!this.inlineMatches(group.nodes, source))
					source = group.nodes
						.map((node) => {
							const unmarked = { ...node, marks: [] }
							let text = super.renderNodes([unmarked], parent, '', 0, level)
							if (!this.inlineMatches([unmarked], text))
								text = `[tiptap ${JSON.stringify(unmarked)}]`
							return node.marks?.length
								? `[marks ${JSON.stringify(node.marks)}]${text}[/marks]`
								: text
						})
						.join('')
				if (!group.style) return source
				const attrs = Object.fromEntries(
					Object.entries(group.style).filter(([, value]) => value != null),
				)
				return `[textStyle ${JSON.stringify(attrs)}]${source}[/textStyle]`
			})
			.join('')
	}

	override renderNodes(
		nodes: JSONContent | JSONContent[],
		parent?: JSONContent,
		separator = '',
		index = 0,
		level = 0,
	): string {
		if (Array.isArray(nodes) && parent?.type && this.schema.nodes[parent.type]?.inlineContent)
			return this.inline(nodes, parent, level)
		return super.renderNodes(nodes, parent, separator, index, level)
	}

	override renderNodeToMarkdown(
		node: JSONContent,
		parent?: JSONContent,
		index = 0,
		level = 0,
		meta: Record<string, unknown> = {},
	): string {
		if (node.type === 'reference') return `[ref ${JSON.stringify(node.attrs ?? {})}]`
		if (node.type === 'figureCaption')
			return fencedBlock('caption', this.renderNodes(node.content ?? [], node, '', 0, level))
		if (node.type === 'figure') {
			const body = this.renderNodes(node.content ?? [], node, '\n\n', 0, level)
			const source = fencedBlock('figure', body, node.attrs ?? {})
			const parsed = this.parse(source).content
			return parsed?.length === 1 && this.same(node, parsed[0]!) ? source : agentNodeMarkdown(node)
		}
		const source = super.renderNodeToMarkdown(node, parent, index, level, meta)
		if (!node.type || !this.schema.nodes[node.type]?.isInGroup('block')) return source
		if (source.includes(':::') && reservedBlockText(this.instance.lexer(source)))
			return agentNodeMarkdown(node)
		const parsed = this.parse(source).content
		if (parsed?.length === 1) {
			const actual = parsed[0]!
			const previous = parent?.content?.[index - 1]
			const boundary =
				previous?.type === node.type &&
				['bulletList', 'orderedList', 'blockquote'].includes(node.type)
			if (this.same(node, actual)) return boundary ? attributeBlock({}, source) : source
			const attrs = this.schema.nodeFromJSON(node).attrs
			if (this.same(node, { ...actual, attrs })) {
				const parsedAttrs = this.schema.nodeFromJSON(actual).attrs
				const extra = Object.fromEntries(
					Object.entries(attrs).filter(
						([key, value]) => JSON.stringify(value) !== JSON.stringify(parsedAttrs[key]),
					),
				)
				return attributeBlock(extra, source)
			}
		}
		return agentNodeMarkdown(node)
	}
}
