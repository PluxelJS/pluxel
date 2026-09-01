import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import {
	WORKBENCH_PAGE_ARTIFACT_FILE,
	WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchPageSet,
	parseWorkbenchPageDeploymentInventory,
	parseWorkbenchPageSet,
	serializeWorkbenchPageDefinition,
	serializeWorkbenchPageSet,
	workbenchPageArtifactRoot,
	type WorkbenchPageBlock,
	type WorkbenchPageInline,
	type WorkbenchPageTableAlignment,
	type WorkbenchPageTableRow,
	type WorkbenchStandardPagePlanV1,
} from '@pluxel/core/internal'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { isAbsolute, relative, resolve } from 'pathe'
import type { Root, RootContent, PhrasingContent, Definition } from 'mdast'
import type { WorkbenchSemanticPageCompilation } from './semantic-lowering.ts'

const MAX_MARKDOWN_BYTES = 256 * 1_024
const UNSUPPORTED_DIRECTIVE = /^\s*:{2,3}[A-Za-z][A-Za-z0-9_-]*(?:\[|\{|\s|$)/mu

export type CompileWorkbenchPageSetInput = Readonly<{
	definition: PluginDefinitionAddress
	root: string
	entries: readonly Readonly<{ key: string; sourcePath: string }>[]
}>

type MarkdownCompiler = {
	definitions: ReadonlyMap<string, Definition>
	anchors: Set<string>
}

/** Compiles one definition-scoped Page set, or reuses its exact packaged artifact. */
export async function compileWorkbenchPageSet(
	input: CompileWorkbenchPageSetInput,
): Promise<WorkbenchSemanticPageCompilation> {
	const root = await canonicalDirectory(input.root)
	const availability = await Promise.all(
		input.entries.map((entry) =>
			stat(entry.sourcePath)
				.then((value) => value.isFile())
				.catch(() => false),
		),
	)
	if (availability.every((available) => !available)) {
		return loadPackagedPageSet(input, root)
	}
	if (availability.some((available) => !available)) {
		throw pageError(root, 'Page set mixes available and missing Markdown sources')
	}

	const entries = []
	const sources: string[] = []
	for (const entry of input.entries) {
		const sourcePath = await canonicalMarkdownFile(root, entry.sourcePath)
		sources.push(sourcePath)
		const bytes = await readFile(sourcePath)
		if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
			throw pageError(sourcePath, `Markdown source exceeds ${MAX_MARKDOWN_BYTES} bytes`)
		}
		let source: string
		try {
			source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		} catch (cause) {
			throw pageError(sourcePath, 'Markdown source is not valid UTF-8', cause)
		}
		if (UNSUPPORTED_DIRECTIVE.test(source)) {
			throw pageError(sourcePath, 'Markdown directives are not supported in Standard Pages v1')
		}
		if (hasLeadingFrontmatter(source)) {
			throw pageError(sourcePath, '1:1: frontmatter is not supported in Standard Pages v1')
		}
		entries.push(Object.freeze({ key: entry.key, page: compileMarkdown(sourcePath, source) }))
	}

	const pageSet = createWorkbenchPageSet({ definition: input.definition, entries })
	return compiled(root, pageSet, sources)
}

function compileMarkdown(sourcePath: string, source: string): WorkbenchStandardPagePlanV1 {
	let root: Root
	try {
		root = fromMarkdown(source, {
			extensions: [gfm()],
			mdastExtensions: [gfmFromMarkdown()],
		})
	} catch (cause) {
		throw pageError(sourcePath, 'cannot parse Markdown', cause)
	}
	const definitions = new Map<string, Definition>()
	for (const node of root.children) {
		if (node.type !== 'definition') continue
		if (definitions.has(node.identifier)) {
			throw nodeError(sourcePath, node, `duplicate link definition ${node.identifier}`)
		}
		definitions.set(node.identifier, node)
	}
	const compiler: MarkdownCompiler = { definitions, anchors: new Set() }
	const blocks = root.children.flatMap((node) =>
		node.type === 'definition' ? [] : [compileBlock(sourcePath, node, compiler)],
	)
	return {
		version: 1,
		kind: 'standard-page',
		document: { version: 1, blocks },
	}
}

function compileBlock(
	sourcePath: string,
	node: RootContent,
	compiler: MarkdownCompiler,
): WorkbenchPageBlock {
	switch (node.type) {
		case 'heading': {
			const anchor = uniqueAnchor(headingText(node.children), compiler.anchors)
			return {
				type: 'heading',
				level: node.depth,
				anchor,
				children: compileInlines(sourcePath, node.children, compiler),
			}
		}
		case 'paragraph':
			return {
				type: 'paragraph',
				children: compileInlines(sourcePath, node.children, compiler),
			}
		case 'blockquote':
			return {
				type: 'blockquote',
				children: node.children.map((child) => compileBlock(sourcePath, child, compiler)),
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
						children: item.children.map((child) => compileBlock(sourcePath, child, compiler)),
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
			const align = node.align.map((value): WorkbenchPageTableAlignment => value ?? null)
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
): WorkbenchPageTableRow {
	return cells.map((cell) => compileInlines(sourcePath, cell.children, compiler))
}

function compileInlines(
	sourcePath: string,
	nodes: readonly PhrasingContent[],
	compiler: MarkdownCompiler,
): readonly WorkbenchPageInline[] {
	return nodes.map((node): WorkbenchPageInline => {
		switch (node.type) {
			case 'text':
				return { type: 'text', value: node.value }
			case 'inlineCode':
				return { type: 'code', value: node.value }
			case 'emphasis':
			case 'strong':
			case 'delete':
				return {
					type: node.type,
					children: compileInlines(sourcePath, node.children, compiler),
				}
			case 'link':
				if (node.title) throw nodeError(sourcePath, node, 'link titles are not supported')
				return {
					type: 'link',
					target: compileLinkTarget(sourcePath, node, node.url),
					children: compileInlines(sourcePath, node.children, compiler),
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
					children: compileInlines(sourcePath, node.children, compiler),
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

async function loadPackagedPageSet(
	input: CompileWorkbenchPageSetInput,
	root: string,
): Promise<WorkbenchSemanticPageCompilation> {
	const deploymentRoot = resolve(root, 'dist/workbench')
	const inventoryPath = resolve(deploymentRoot, WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE)
	let inventory
	try {
		inventory = parseWorkbenchPageDeploymentInventory(
			JSON.parse(await readFile(inventoryPath, 'utf-8')) as unknown,
		)
	} catch (cause) {
		throw pageError(
			root,
			'Markdown sources are unavailable and no valid packaged Page inventory exists',
			cause,
		)
	}
	const definitionKey = pluginDefinitionIndexKey(input.definition)
	const page = inventory.pages.find(
		(entry) => pluginDefinitionIndexKey(entry.definition) === definitionKey,
	)
	if (!page) throw pageError(root, 'packaged Page inventory has no entry for this definition')
	const definitionDigest = sha256(serializeWorkbenchPageDefinition(input.definition))
	if (
		page.definitionDigest !== definitionDigest ||
		page.artifactRoot !== workbenchPageArtifactRoot(definitionDigest, page.digest)
	) {
		throw pageError(root, 'packaged Page inventory entry is not canonical for this definition')
	}
	const path = resolve(deploymentRoot, page.artifactRoot, WORKBENCH_PAGE_ARTIFACT_FILE)
	const bytes = await readFile(path).catch((cause) => {
		throw pageError(path, 'packaged Page artifact is missing', cause)
	})
	if (sha256(bytes) !== page.digest) {
		throw pageError(path, 'packaged Page artifact digest does not match its inventory')
	}
	let serialized: string
	try {
		serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch (cause) {
		throw pageError(path, 'packaged Page artifact is not valid UTF-8', cause)
	}
	let pageSet
	try {
		pageSet = parseWorkbenchPageSet(JSON.parse(serialized) as unknown)
	} catch (cause) {
		throw pageError(path, 'packaged Page artifact is invalid', cause)
	}
	if (serializeWorkbenchPageSet(pageSet) !== serialized) {
		throw pageError(path, 'packaged Page artifact is not canonically serialized')
	}
	if (pluginDefinitionIndexKey(pageSet.definition) !== definitionKey) {
		throw pageError(path, 'packaged Page artifact belongs to another definition')
	}
	const expectedKeys = input.entries.map((entry) => entry.key).sort()
	const actualKeys = pageSet.entries.map((entry) => entry.key)
	if (
		expectedKeys.length !== actualKeys.length ||
		expectedKeys.some((key, index) => key !== actualKeys[index])
	) {
		throw pageError(path, 'packaged Page artifact entries do not match the current declaration')
	}
	return Object.freeze({
		pageSet,
		digest: page.digest,
		bytes: Uint8Array.from(bytes),
		root,
		sources: Object.freeze([]),
	})
}

function compiled(
	root: string,
	pageSet: ReturnType<typeof createWorkbenchPageSet>,
	sources: readonly string[],
) {
	const serialized = serializeWorkbenchPageSet(pageSet)
	const bytes = new TextEncoder().encode(serialized)
	return Object.freeze({
		pageSet,
		digest: sha256(bytes),
		bytes,
		root,
		sources: Object.freeze([...sources].sort()),
	})
}

async function canonicalDirectory(input: string): Promise<string> {
	const root = await realpath(resolve(input)).catch((cause) => {
		throw pageError(input, 'package root does not exist', cause)
	})
	const rootStat = await stat(root)
	if (!rootStat.isDirectory()) throw pageError(root, 'package root is not a directory')
	return root
}

async function canonicalMarkdownFile(root: string, input: string): Promise<string> {
	const path = await realpath(resolve(input)).catch((cause) => {
		throw pageError(input, 'Markdown source does not exist', cause)
	})
	const fromRoot = relative(root, path)
	if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw pageError(path, 'Markdown source escapes its package root')
	}
	const pathStat = await stat(path)
	if (!pathStat.isFile()) throw pageError(path, 'Markdown source is not a regular file')
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
	return pageError(path, `${start ? `${start.line}:${start.column}: ` : ''}${message}`, cause)
}

function pageError(path: string, message: string, cause?: unknown): Error {
	return new Error(`[workbench-page] ${path}: ${message}`, cause === undefined ? {} : { cause })
}
