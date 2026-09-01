import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchContentSet,
	parseWorkbenchContentDeploymentInventory,
	parseWorkbenchContentSet,
	serializeWorkbenchContentDefinition,
	serializeWorkbenchContentSet,
	workbenchContentArtifactRoot,
	type WorkbenchContentBlock,
	type WorkbenchContentInline,
	type WorkbenchContentPlan,
	type WorkbenchContentTableAlignment,
	type WorkbenchContentTableRow,
} from '@pluxel/core/internal'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { directiveFromMarkdown, type Directives } from 'mdast-util-directive'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { directive } from 'micromark-extension-directive'
import { gfm } from 'micromark-extension-gfm'
import { isAbsolute, relative, resolve } from 'pathe'
import type { Root, RootContent, PhrasingContent, Definition } from 'mdast'
import type {
	WorkbenchSemanticContentCompilation,
	WorkbenchSemanticContentSlot,
} from './semantic-lowering.ts'

const MAX_MARKDOWN_BYTES = 256 * 1_024
const ENTRY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/

export type CompileWorkbenchContentSetInput = Readonly<{
	definition: PluginDefinitionAddress
	root: string
	entries: readonly Readonly<{
		key: string
		sourcePath: string
		slots: readonly WorkbenchSemanticContentSlot[]
	}>[]
}>

type MarkdownCompiler = {
	definitions: ReadonlyMap<string, Definition>
	anchors: Set<string>
	slots: ReadonlyMap<string, WorkbenchSemanticContentSlot>
	placements: Map<string, 'inline' | 'block'>
}

/** Compiles one definition-scoped Content set, or reuses its exact packaged artifact. */
export async function compileWorkbenchContentSet(
	input: CompileWorkbenchContentSetInput,
): Promise<WorkbenchSemanticContentCompilation> {
	const root = await canonicalDirectory(input.root)
	const availability = await Promise.all(
		input.entries.map((entry) =>
			stat(entry.sourcePath)
				.then((value) => value.isFile())
				.catch(() => false),
		),
	)
	if (availability.every((available) => !available)) {
		return loadPackagedContentSet(input, root)
	}
	if (availability.some((available) => !available)) {
		throw contentError(root, 'Content set mixes available and missing Markdown sources')
	}

	const entries = []
	const sources: string[] = []
	for (const entry of input.entries) {
		const sourcePath = await canonicalMarkdownFile(root, entry.sourcePath)
		sources.push(sourcePath)
		const bytes = await readFile(sourcePath)
		if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
			throw contentError(sourcePath, `Markdown source exceeds ${MAX_MARKDOWN_BYTES} bytes`)
		}
		let source: string
		try {
			source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		} catch (cause) {
			throw contentError(sourcePath, 'Markdown source is not valid UTF-8', cause)
		}
		if (hasLeadingFrontmatter(source)) {
			throw contentError(sourcePath, '1:1: frontmatter is not supported in Workbench Content')
		}
		entries.push(
			Object.freeze({
				key: entry.key,
				content: compileMarkdown(sourcePath, source, entry.slots),
			}),
		)
	}

	const contentSet = createWorkbenchContentSet({ definition: input.definition, entries })
	return compiled(root, contentSet, sources)
}

function compileMarkdown(
	sourcePath: string,
	source: string,
	slots: readonly WorkbenchSemanticContentSlot[],
): WorkbenchContentPlan {
	let root: Root
	try {
		root = fromMarkdown(source, {
			extensions: [gfm(), directive()],
			mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()],
		})
	} catch (cause) {
		throw contentError(sourcePath, 'cannot parse Markdown', cause)
	}
	const definitions = new Map<string, Definition>()
	for (const node of root.children) {
		if (node.type !== 'definition') continue
		if (definitions.has(node.identifier)) {
			throw nodeError(sourcePath, node, `duplicate link definition ${node.identifier}`)
		}
		definitions.set(node.identifier, node)
	}
	const compiler: MarkdownCompiler = {
		definitions,
		anchors: new Set(),
		slots: new Map(slots.map((slot) => [slot.key, slot])),
		placements: new Map(),
	}
	const blocks = root.children.flatMap((node) =>
		node.type === 'definition' ? [] : [compileBlock(sourcePath, node, compiler, true)],
	)
	for (const slot of slots) {
		if (!compiler.placements.has(slot.key)) {
			throw contentError(sourcePath, `Workbench Content slot ${slot.key} must appear exactly once`)
		}
	}
	const planSlots = slots.map((slot) => {
		const display = compiler.placements.get(slot.key)!
		if (slot.kind === 'data') return { kind: 'data' as const, key: slot.key, display }
		return {
			kind: 'action' as const,
			key: slot.key,
			display: 'block' as const,
			label: slot.label,
			input: slot.input,
			...(slot.confirm === undefined ? {} : { confirm: slot.confirm }),
		}
	})
	return {
		version: 1,
		kind: 'workbench-content',
		document: { version: 1, blocks },
		slots: planSlots,
	}
}

function compileBlock(
	sourcePath: string,
	node: RootContent,
	compiler: MarkdownCompiler,
	allowSlot: boolean,
): WorkbenchContentBlock {
	switch (node.type) {
		case 'leafDirective':
			if (!allowSlot) throw nodeError(sourcePath, node, 'Workbench Content slots cannot be nested')
			return compileSlot(sourcePath, node, compiler, 'block')
		case 'containerDirective':
			throw nodeError(sourcePath, node, 'container directives are not supported')
		case 'textDirective':
			throw nodeError(sourcePath, node, 'inline slots must appear inside a paragraph')
		case 'heading': {
			const anchor = uniqueAnchor(headingText(node.children), compiler.anchors)
			return {
				type: 'heading',
				level: node.depth,
				anchor,
				children: compileInlines(sourcePath, node.children, compiler, false),
			}
		}
		case 'paragraph':
			return {
				type: 'paragraph',
				children: compileInlines(sourcePath, node.children, compiler, allowSlot),
			}
		case 'blockquote':
			return {
				type: 'blockquote',
				children: node.children.map((child) => compileBlock(sourcePath, child, compiler, false)),
			}
		case 'list':
			return {
				type: 'list',
				ordered: node.ordered === true,
				...(node.ordered === true ? { start: node.start ?? 1 } : {}),
				items: node.children.map((item) => {
					if (item.checked !== null && item.checked !== undefined) {
						throw nodeError(sourcePath, item, 'task list items are not supported')
					}
					return {
						children: item.children.map((child) =>
							compileBlock(sourcePath, child, compiler, false),
						),
					}
				}),
			}
		case 'thematicBreak':
			return { type: 'thematic-break' }
		case 'code':
			if (node.meta) throw nodeError(sourcePath, node, 'fenced code metadata is not supported')
			return {
				type: 'code',
				...(node.lang ? { language: node.lang } : {}),
				value: node.value,
			}
		case 'table': {
			const [header, ...rows] = node.children
			if (!header) throw nodeError(sourcePath, node, 'table must contain a header')
			const align = node.align.map((value): WorkbenchContentTableAlignment => value ?? null)
			return {
				type: 'table',
				align,
				header: compileTableRow(sourcePath, header.children, compiler),
				rows: rows.map((row) => compileTableRow(sourcePath, row.children, compiler)),
			}
		}
		case 'html':
			throw nodeError(sourcePath, node, 'raw HTML and MDX are not supported')
		default:
			throw nodeError(sourcePath, node, `Markdown node ${node.type} is not supported`)
	}
}

function compileTableRow(
	sourcePath: string,
	cells: readonly { children: PhrasingContent[] }[],
	compiler: MarkdownCompiler,
): WorkbenchContentTableRow {
	return cells.map((cell) => compileInlines(sourcePath, cell.children, compiler, false))
}

function compileSlot(
	sourcePath: string,
	node: Directives,
	compiler: MarkdownCompiler,
	display: 'inline' | 'block',
): Readonly<{ type: 'slot'; key: string }> {
	if (node.name !== 'slot') {
		throw nodeError(sourcePath, node, `directive ${node.name} is not supported`)
	}
	if (Object.keys(node.attributes ?? {}).length > 0) {
		throw nodeError(sourcePath, node, 'Workbench Content slots do not accept attributes')
	}
	if (
		node.children.length !== 1 ||
		node.children[0]?.type !== 'text' ||
		!ENTRY_KEY.test(node.children[0].value)
	) {
		throw nodeError(sourcePath, node, 'Workbench Content slot label must be one static key')
	}
	const key = node.children[0].value
	const declaration = compiler.slots.get(key)
	if (!declaration) {
		throw nodeError(sourcePath, node, `Workbench Content slot ${key} is undeclared`)
	}
	if (compiler.placements.has(key)) {
		throw nodeError(sourcePath, node, `Workbench Content slot ${key} must appear exactly once`)
	}
	if (display === 'inline' && declaration.kind === 'action') {
		throw nodeError(sourcePath, node, `Workbench Content action slot ${key} must be block-level`)
	}
	compiler.placements.set(key, display)
	return { type: 'slot', key }
}

function compileInlines(
	sourcePath: string,
	nodes: readonly PhrasingContent[],
	compiler: MarkdownCompiler,
	allowSlot: boolean,
): readonly WorkbenchContentInline[] {
	return nodes.map((node): WorkbenchContentInline => {
		switch (node.type) {
			case 'textDirective':
				if (!allowSlot) {
					throw nodeError(sourcePath, node, 'Workbench Content slots cannot be nested')
				}
				return compileSlot(sourcePath, node, compiler, 'inline')
			case 'text':
				return { type: 'text', value: node.value }
			case 'inlineCode':
				return { type: 'code', value: node.value }
			case 'emphasis':
			case 'strong':
			case 'delete':
				return {
					type: node.type,
					children: compileInlines(sourcePath, node.children, compiler, false),
				}
			case 'link':
				if (node.title) throw nodeError(sourcePath, node, 'link titles are not supported')
				return {
					type: 'link',
					target: compileLinkTarget(sourcePath, node, node.url),
					children: compileInlines(sourcePath, node.children, compiler, false),
				}
			case 'linkReference': {
				const definition = compiler.definitions.get(node.identifier)
				if (!definition) {
					throw nodeError(sourcePath, node, `link definition ${node.identifier} is missing`)
				}
				if (definition.title) {
					throw nodeError(sourcePath, definition, 'link titles are not supported')
				}
				return {
					type: 'link',
					target: compileLinkTarget(sourcePath, node, definition.url),
					children: compileInlines(sourcePath, node.children, compiler, false),
				}
			}
			case 'html':
				throw nodeError(sourcePath, node, 'raw HTML and MDX are not supported')
			case 'image':
			case 'imageReference':
				throw nodeError(sourcePath, node, 'images are not supported')
			default:
				throw nodeError(sourcePath, node, `inline Markdown node ${node.type} is not supported`)
		}
	})
}

function compileLinkTarget(
	sourcePath: string,
	node: { position?: RootContent['position'] },
	href: string,
) {
	if (href.startsWith('#')) {
		let anchor: string
		try {
			anchor = decodeURIComponent(href.slice(1))
		} catch (cause) {
			throw nodeError(sourcePath, node, 'fragment link is not valid URL encoding', cause)
		}
		return { kind: 'fragment' as const, anchor: normalizeAnchor(anchor) }
	}
	let url: URL
	try {
		url = new URL(href)
	} catch (cause) {
		throw nodeError(sourcePath, node, 'relative and invalid links are not supported', cause)
	}
	if (url.protocol !== 'https:' && url.protocol !== 'mailto:') {
		throw nodeError(sourcePath, node, `link protocol ${url.protocol} is not supported`)
	}
	return { kind: url.protocol === 'https:' ? ('https' as const) : ('mailto' as const), href }
}

function headingText(nodes: readonly PhrasingContent[]): string {
	return nodes
		.map((node): string => {
			switch (node.type) {
				case 'text':
				case 'inlineCode':
					return node.value
				case 'emphasis':
				case 'strong':
				case 'delete':
				case 'link':
				case 'linkReference':
					return headingText(node.children)
				case 'image':
				case 'imageReference':
					return node.alt
				default:
					return ''
			}
		})
		.join(' ')
}

function uniqueAnchor(input: string, used: Set<string>): string {
	const base = normalizeAnchor(input)
	let anchor = base
	let suffix = 2
	while (used.has(anchor)) {
		anchor = `${base.slice(0, Math.max(1, 127 - String(suffix).length - 1))}-${suffix}`
		suffix += 1
	}
	used.add(anchor)
	return anchor
}

function normalizeAnchor(input: string): string {
	return (
		input
			.normalize('NFKD')
			.replaceAll(/[\u0300-\u036f]/gu, '')
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/gu, '-')
			.replaceAll(/^-+|-+$/gu, '')
			.slice(0, 120)
			.replaceAll(/-+$/gu, '') || 'section'
	)
}

function hasLeadingFrontmatter(source: string): boolean {
	const lines = source.replace(/^\uFEFF/u, '').split(/\r?\n/u)
	if (!/^---[\t ]*$/u.test(lines[0] ?? '')) return false
	return lines.slice(1).some((line) => /^(?:---|\.\.\.)[\t ]*$/u.test(line))
}

async function loadPackagedContentSet(
	input: CompileWorkbenchContentSetInput,
	root: string,
): Promise<WorkbenchSemanticContentCompilation> {
	const deploymentRoot = resolve(root, 'dist/workbench')
	const inventoryPath = resolve(deploymentRoot, WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE)
	let inventory
	try {
		inventory = parseWorkbenchContentDeploymentInventory(
			JSON.parse(await readFile(inventoryPath, 'utf-8')) as unknown,
		)
	} catch (cause) {
		throw contentError(
			root,
			'Markdown sources are unavailable and no valid packaged Content inventory exists',
			cause,
		)
	}
	const definitionKey = pluginDefinitionIndexKey(input.definition)
	const content = inventory.entries.find(
		(entry) => pluginDefinitionIndexKey(entry.definition) === definitionKey,
	)
	if (!content) {
		throw contentError(root, 'packaged Content inventory has no entry for this definition')
	}
	const definitionDigest = sha256(serializeWorkbenchContentDefinition(input.definition))
	if (
		content.definitionDigest !== definitionDigest ||
		content.artifactRoot !== workbenchContentArtifactRoot(definitionDigest, content.digest)
	) {
		throw contentError(
			root,
			'packaged Content inventory entry is not canonical for this definition',
		)
	}
	const path = resolve(deploymentRoot, content.artifactRoot, WORKBENCH_CONTENT_ARTIFACT_FILE)
	const bytes = await readFile(path).catch((cause) => {
		throw contentError(path, 'packaged Content artifact is missing', cause)
	})
	if (sha256(bytes) !== content.digest) {
		throw contentError(path, 'packaged Content artifact digest does not match its inventory')
	}
	let serialized: string
	try {
		serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch (cause) {
		throw contentError(path, 'packaged Content artifact is not valid UTF-8', cause)
	}
	let contentSet
	try {
		contentSet = parseWorkbenchContentSet(JSON.parse(serialized) as unknown)
	} catch (cause) {
		throw contentError(path, 'packaged Content artifact is invalid', cause)
	}
	if (serializeWorkbenchContentSet(contentSet) !== serialized) {
		throw contentError(path, 'packaged Content artifact is not canonically serialized')
	}
	if (pluginDefinitionIndexKey(contentSet.definition) !== definitionKey) {
		throw contentError(path, 'packaged Content artifact belongs to another definition')
	}
	const expectedKeys = input.entries.map((entry) => entry.key).sort()
	const actualKeys = contentSet.entries.map((entry) => entry.key)
	if (
		expectedKeys.length !== actualKeys.length ||
		expectedKeys.some((key, index) => key !== actualKeys[index])
	) {
		throw contentError(
			path,
			'packaged Content artifact entries do not match the current declaration',
		)
	}
	for (const expected of input.entries) {
		const actual = contentSet.entries.find((entry) => entry.key === expected.key)!
		if (!contentSlotDeclarationsMatch(expected.slots, actual.content.slots)) {
			throw contentError(
				path,
				`packaged Content artifact slots do not match declaration ${expected.key}`,
			)
		}
	}
	return Object.freeze({
		contentSet,
		digest: content.digest,
		bytes: Uint8Array.from(bytes),
		root,
		sources: Object.freeze([]),
	})
}

function contentSlotDeclarationsMatch(
	expected: readonly WorkbenchSemanticContentSlot[],
	actual: WorkbenchContentPlan['slots'],
): boolean {
	if (expected.length !== actual.length) return false
	return expected.every((slot, index) => {
		const candidate = actual[index]
		if (!candidate || candidate.key !== slot.key || candidate.kind !== slot.kind) return false
		if (slot.kind === 'data' || candidate.kind !== 'action') return true
		return (
			candidate.label === slot.label &&
			candidate.input === slot.input &&
			candidate.confirm === slot.confirm
		)
	})
}

function compiled(
	root: string,
	contentSet: ReturnType<typeof createWorkbenchContentSet>,
	sources: readonly string[],
) {
	const serialized = serializeWorkbenchContentSet(contentSet)
	const bytes = new TextEncoder().encode(serialized)
	return Object.freeze({
		contentSet,
		digest: sha256(bytes),
		bytes,
		root,
		sources: Object.freeze([...sources].sort()),
	})
}

async function canonicalDirectory(input: string): Promise<string> {
	const root = await realpath(resolve(input)).catch((cause) => {
		throw contentError(input, 'package root does not exist', cause)
	})
	const rootStat = await stat(root)
	if (!rootStat.isDirectory()) throw contentError(root, 'package root is not a directory')
	return root
}

async function canonicalMarkdownFile(root: string, input: string): Promise<string> {
	const path = await realpath(resolve(input)).catch((cause) => {
		throw contentError(input, 'Markdown source does not exist', cause)
	})
	const fromRoot = relative(root, path)
	if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw contentError(path, 'Markdown source escapes its package root')
	}
	const pathStat = await stat(path)
	if (!pathStat.isFile()) throw contentError(path, 'Markdown source is not a regular file')
	return path
}

function sha256(input: Uint8Array | string): string {
	return createHash('sha256').update(input).digest('hex')
}

function nodeError(
	path: string,
	node: { position?: RootContent['position'] },
	message: string,
	cause?: unknown,
): Error {
	const start = node.position?.start
	return contentError(path, `${start ? `${start.line}:${start.column}: ` : ''}${message}`, cause)
}

function contentError(path: string, message: string, cause?: unknown): Error {
	return new Error(`[workbench-content] ${path}: ${message}`, cause === undefined ? {} : { cause })
}
