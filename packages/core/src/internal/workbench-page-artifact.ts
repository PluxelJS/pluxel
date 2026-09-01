import {
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '../plugins/runtime/identity'

export const WORKBENCH_PAGE_ARTIFACT_VERSION = 1 as const
export const WORKBENCH_PAGE_ARTIFACT_ROOT = 'pages' as const
export const WORKBENCH_PAGE_ARTIFACT_FILE = 'page-plan.json' as const
export const WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE = 'pluxel-workbench-pages.json' as const

export type WorkbenchPageInline =
	| Readonly<{ type: 'text'; value: string }>
	| Readonly<{ type: 'code'; value: string }>
	| Readonly<{
			type: 'emphasis' | 'strong' | 'delete'
			children: readonly WorkbenchPageInline[]
	  }>
	| Readonly<{
			type: 'link'
			target:
				| Readonly<{ kind: 'https' | 'mailto'; href: string }>
				| Readonly<{ kind: 'fragment'; anchor: string }>
			children: readonly WorkbenchPageInline[]
	  }>

export type WorkbenchPageTableAlignment = 'left' | 'center' | 'right' | null
export type WorkbenchPageTableCell = readonly WorkbenchPageInline[]
export type WorkbenchPageTableRow = readonly WorkbenchPageTableCell[]

export type WorkbenchPageBlock =
	| Readonly<{
			type: 'heading'
			level: 1 | 2 | 3 | 4 | 5 | 6
			anchor: string
			children: readonly WorkbenchPageInline[]
	  }>
	| Readonly<{ type: 'paragraph'; children: readonly WorkbenchPageInline[] }>
	| Readonly<{ type: 'blockquote'; children: readonly WorkbenchPageBlock[] }>
	| Readonly<{
			type: 'list'
			ordered: boolean
			start?: number
			items: readonly Readonly<{ children: readonly WorkbenchPageBlock[] }>[]
	  }>
	| Readonly<{ type: 'thematic-break' }>
	| Readonly<{ type: 'code'; language?: string; value: string }>
	| Readonly<{
			type: 'table'
			align: readonly WorkbenchPageTableAlignment[]
			header: WorkbenchPageTableRow
			rows: readonly WorkbenchPageTableRow[]
	  }>

export type WorkbenchPageDocumentPlanV1 = Readonly<{
	version: typeof WORKBENCH_PAGE_ARTIFACT_VERSION
	blocks: readonly WorkbenchPageBlock[]
}>

export type WorkbenchStandardPagePlanV1 = Readonly<{
	version: typeof WORKBENCH_PAGE_ARTIFACT_VERSION
	kind: 'standard-page'
	document: WorkbenchPageDocumentPlanV1
}>

export type WorkbenchPageSetEntryV1 = Readonly<{
	key: string
	page: WorkbenchStandardPagePlanV1
}>

export type WorkbenchPageSetV1 = Readonly<{
	version: typeof WORKBENCH_PAGE_ARTIFACT_VERSION
	kind: 'workbench-page-set'
	definition: PluginDefinitionAddress
	entries: readonly WorkbenchPageSetEntryV1[]
}>

export type WorkbenchPageDeploymentEntryV1 = Readonly<{
	definition: PluginDefinitionAddress
	definitionDigest: string
	digest: string
	artifactRoot: string
}>

export type WorkbenchPageDeploymentInventoryV1 = Readonly<{
	version: typeof WORKBENCH_PAGE_ARTIFACT_VERSION
	pages: readonly WorkbenchPageDeploymentEntryV1[]
}>

const ENTRY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/
const RESERVED_ENTRY_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'then'])
const SHA256 = /^[a-f\d]{64}$/
const ANCHOR = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/
const CODE_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,31}$/
const MAX_SERIALIZED_BYTES = 512 * 1_024
const MAX_NODES = 4_096
const MAX_DEPTH = 32
const MAX_TEXT_BYTES = 128 * 1_024
const MAX_CODE_BLOCK_BYTES = 64 * 1_024
const MAX_LINKS = 256
const MAX_LIST_ITEMS = 512
const MAX_TABLE_COLUMNS = 16
const MAX_TABLE_ROWS = 64
const MAX_TABLE_CELLS = 1_024

type Budget = {
	nodes: number
	textBytes: number
	links: number
	listItems: number
	tableCells: number
	anchors: Set<string>
	fragments: string[]
}

export function createWorkbenchPageSet(input: {
	definition: PluginDefinitionAddress
	entries: readonly Readonly<{ key: string; page: WorkbenchStandardPagePlanV1 }>[]
}): WorkbenchPageSetV1 {
	return parseWorkbenchPageSet({
		version: WORKBENCH_PAGE_ARTIFACT_VERSION,
		kind: 'workbench-page-set',
		definition: input.definition,
		entries: input.entries,
	})
}

export function parseWorkbenchPageSet(input: unknown): WorkbenchPageSetV1 {
	const record = exact(input, 'Workbench Page set', ['version', 'kind', 'definition', 'entries'])
	if (record.version !== 1 || record.kind !== 'workbench-page-set') {
		throw invalid('Workbench Page set version or kind is unsupported')
	}
	if (!Array.isArray(record.entries) || record.entries.length === 0) {
		throw invalid('Workbench Page set entries must be a non-empty array')
	}
	let previous = ''
	const entries = record.entries.map((entryInput, index) => {
		const entry = exact(entryInput, `Workbench Page set entry ${index}`, ['key', 'page'])
		const key = pageKey(entry.key, `Workbench Page set entry ${index} key`)
		if (key <= previous) throw invalid('Workbench Page set entries must use unique sorted keys')
		previous = key
		return Object.freeze({ key, page: parseWorkbenchStandardPagePlan(entry.page) })
	})
	const output = Object.freeze({
		version: WORKBENCH_PAGE_ARTIFACT_VERSION,
		kind: 'workbench-page-set' as const,
		definition: parsePluginDefinitionAddress(record.definition),
		entries: Object.freeze(entries),
	})
	assertSerializedBudget(output, 'Workbench Page set')
	return output
}

export function serializeWorkbenchPageSet(input: WorkbenchPageSetV1): string {
	return `${JSON.stringify(parseWorkbenchPageSet(input))}\n`
}

export function serializeWorkbenchPageDefinition(definition: PluginDefinitionAddress): string {
	return `${JSON.stringify(parsePluginDefinitionAddress(definition))}\n`
}

export function createWorkbenchPageDeploymentInventory(
	pages: readonly WorkbenchPageDeploymentEntryV1[],
): WorkbenchPageDeploymentInventoryV1 {
	return parseWorkbenchPageDeploymentInventory({
		version: WORKBENCH_PAGE_ARTIFACT_VERSION,
		pages,
	})
}

export function parseWorkbenchPageDeploymentInventory(
	input: unknown,
): WorkbenchPageDeploymentInventoryV1 {
	const record = exact(input, 'Workbench Page deployment inventory', ['version', 'pages'])
	if (record.version !== 1 || !Array.isArray(record.pages)) {
		throw invalid('Workbench Page deployment inventory is invalid')
	}
	let previous = ''
	const pages = record.pages.map((pageInput, index) => {
		const entry = exact(pageInput, `Workbench Page deployment entry ${index}`, [
			'definition',
			'definitionDigest',
			'digest',
			'artifactRoot',
		])
		const definition = parsePluginDefinitionAddress(entry.definition)
		const key = pluginDefinitionIndexKey(definition)
		if (key <= previous) {
			throw invalid('Workbench Page deployment entries must use unique sorted definitions')
		}
		previous = key
		const definitionDigest = digest(entry.definitionDigest, 'definition digest')
		const pageDigest = digest(entry.digest, 'Page set digest')
		const artifactRoot = workbenchPageArtifactRoot(definitionDigest, pageDigest)
		if (entry.artifactRoot !== artifactRoot) {
			throw invalid('Workbench Page artifact root is non-canonical')
		}
		return Object.freeze({
			definition,
			definitionDigest,
			digest: pageDigest,
			artifactRoot,
		})
	})
	return Object.freeze({ version: WORKBENCH_PAGE_ARTIFACT_VERSION, pages: Object.freeze(pages) })
}

export function workbenchPageArtifactRoot(definitionDigest: string, pageDigest: string): string {
	return `${WORKBENCH_PAGE_ARTIFACT_ROOT}/${digest(definitionDigest, 'definition digest')}/${digest(pageDigest, 'Page set digest')}`
}

export function parseWorkbenchStandardPagePlan(input: unknown): WorkbenchStandardPagePlanV1 {
	const budget: Budget = {
		nodes: 0,
		textBytes: 0,
		links: 0,
		listItems: 0,
		tableCells: 0,
		anchors: new Set(),
		fragments: [],
	}
	const record = exact(input, 'Standard Page plan', ['version', 'kind', 'document'])
	if (record.version !== 1 || record.kind !== 'standard-page') {
		throw invalid('Standard Page plan version or kind is unsupported')
	}
	const document = parseDocument(record.document, budget)
	for (const anchor of budget.fragments) {
		if (!budget.anchors.has(anchor)) {
			throw invalid(`Standard Page fragment does not name a heading: ${anchor}`)
		}
	}
	const output = Object.freeze({
		version: WORKBENCH_PAGE_ARTIFACT_VERSION,
		kind: 'standard-page' as const,
		document,
	})
	assertSerializedBudget(output, 'Standard Page plan')
	return output
}

function parseDocument(input: unknown, budget: Budget): WorkbenchPageDocumentPlanV1 {
	const record = exact(input, 'Standard Page document', ['version', 'blocks'])
	if (record.version !== 1) throw invalid('Standard Page document version is unsupported')
	return Object.freeze({
		version: WORKBENCH_PAGE_ARTIFACT_VERSION,
		blocks: blocks(record.blocks, budget, 1, 'Standard Page document blocks'),
	})
}

function blocks(
	input: unknown,
	budget: Budget,
	depth: number,
	label: string,
): readonly WorkbenchPageBlock[] {
	depthBudget(depth)
	if (!Array.isArray(input)) throw invalid(`${label} must be an array`)
	return Object.freeze(
		input.map((value, index) => block(value, budget, depth, `${label}[${index}]`)),
	)
}

function block(input: unknown, budget: Budget, depth: number, label: string): WorkbenchPageBlock {
	nodeBudget(budget)
	const record = object(input, label)
	if (record.type === 'heading') {
		keys(record, label, ['type', 'level', 'anchor', 'children'])
		if (
			!Number.isInteger(record.level) ||
			(record.level as number) < 1 ||
			(record.level as number) > 6
		) {
			throw invalid(`${label}.level is invalid`)
		}
		const anchor = pattern(record.anchor, `${label}.anchor`, ANCHOR)
		if (budget.anchors.has(anchor)) throw invalid(`${label}.anchor is duplicated`)
		budget.anchors.add(anchor)
		return Object.freeze({
			type: 'heading',
			level: record.level as 1 | 2 | 3 | 4 | 5 | 6,
			anchor,
			children: inlines(record.children, budget, depth + 1, `${label}.children`),
		})
	}
	if (record.type === 'paragraph') {
		keys(record, label, ['type', 'children'])
		return Object.freeze({
			type: 'paragraph',
			children: inlines(record.children, budget, depth + 1, `${label}.children`),
		})
	}
	if (record.type === 'blockquote') {
		keys(record, label, ['type', 'children'])
		return Object.freeze({
			type: 'blockquote',
			children: blocks(record.children, budget, depth + 1, `${label}.children`),
		})
	}
	if (record.type === 'list') return list(record, budget, depth, label)
	if (record.type === 'thematic-break') {
		keys(record, label, ['type'])
		return Object.freeze({ type: 'thematic-break' })
	}
	if (record.type === 'code') {
		optionalKeys(record, label, ['type', 'value'], ['language'])
		const value = text(record.value, `${label}.value`)
		if (bytes(value) > MAX_CODE_BLOCK_BYTES) throw invalid(`${label}.value exceeds its budget`)
		textBudget(budget, value)
		return Object.freeze({
			type: 'code',
			...(record.language === undefined
				? {}
				: { language: pattern(record.language, `${label}.language`, CODE_LANGUAGE) }),
			value,
		})
	}
	if (record.type === 'table') return table(record, budget, depth, label)
	throw invalid(`${label}.type is unsupported`)
}

function list(record: Record<string, unknown>, budget: Budget, depth: number, label: string) {
	optionalKeys(record, label, ['type', 'ordered', 'items'], ['start'])
	if (
		typeof record.ordered !== 'boolean' ||
		!Array.isArray(record.items) ||
		record.items.length === 0
	) {
		throw invalid(`${label} is invalid`)
	}
	budget.listItems += record.items.length
	if (budget.listItems > MAX_LIST_ITEMS) throw invalid('Standard Page list item budget exceeded')
	const start = record.ordered
		? record.start === undefined
			? 1
			: positiveInteger(record.start, `${label}.start`)
		: undefined
	if (!record.ordered && record.start !== undefined) throw invalid(`${label}.start is invalid`)
	return Object.freeze({
		type: 'list' as const,
		ordered: record.ordered,
		...(start === undefined ? {} : { start }),
		items: Object.freeze(
			record.items.map((value, index) => {
				nodeBudget(budget)
				const item = exact(value, `${label}.items[${index}]`, ['children'])
				return Object.freeze({
					children: blocks(item.children, budget, depth + 1, `${label}.items[${index}].children`),
				})
			}),
		),
	})
}

function table(record: Record<string, unknown>, budget: Budget, depth: number, label: string) {
	keys(record, label, ['type', 'align', 'header', 'rows'])
	if (
		!Array.isArray(record.align) ||
		record.align.length === 0 ||
		record.align.length > MAX_TABLE_COLUMNS
	) {
		throw invalid(`${label}.align is invalid`)
	}
	const align = record.align.map((value, index): WorkbenchPageTableAlignment => {
		if (value !== null && value !== 'left' && value !== 'center' && value !== 'right') {
			throw invalid(`${label}.align[${index}] is invalid`)
		}
		return value
	})
	if (!Array.isArray(record.rows) || record.rows.length > MAX_TABLE_ROWS) {
		throw invalid(`${label}.rows exceeds its budget`)
	}
	return Object.freeze({
		type: 'table' as const,
		align: Object.freeze(align),
		header: tableRow(record.header, align.length, budget, depth + 1, `${label}.header`),
		rows: Object.freeze(
			record.rows.map((row, index) =>
				tableRow(row, align.length, budget, depth + 1, `${label}.rows[${index}]`),
			),
		),
	})
}

function tableRow(input: unknown, columns: number, budget: Budget, depth: number, label: string) {
	if (!Array.isArray(input) || input.length !== columns) {
		throw invalid(`${label} must contain exactly ${columns} cells`)
	}
	budget.tableCells += input.length
	if (budget.tableCells > MAX_TABLE_CELLS) throw invalid('Standard Page table cell budget exceeded')
	return Object.freeze(
		input.map((cell, index) => inlines(cell, budget, depth, `${label}[${index}]`)),
	)
}

function inlines(
	input: unknown,
	budget: Budget,
	depth: number,
	label: string,
): readonly WorkbenchPageInline[] {
	depthBudget(depth)
	if (!Array.isArray(input)) throw invalid(`${label} must be an array`)
	return Object.freeze(
		input.map((value, index) => inline(value, budget, depth, `${label}[${index}]`)),
	)
}

function inline(input: unknown, budget: Budget, depth: number, label: string): WorkbenchPageInline {
	nodeBudget(budget)
	const record = object(input, label)
	if (record.type === 'text' || record.type === 'code') {
		keys(record, label, ['type', 'value'])
		const value = text(record.value, `${label}.value`)
		textBudget(budget, value)
		return Object.freeze({ type: record.type, value })
	}
	if (record.type === 'emphasis' || record.type === 'strong' || record.type === 'delete') {
		keys(record, label, ['type', 'children'])
		return Object.freeze({
			type: record.type,
			children: inlines(record.children, budget, depth + 1, `${label}.children`),
		})
	}
	if (record.type !== 'link') throw invalid(`${label}.type is unsupported`)
	keys(record, label, ['type', 'target', 'children'])
	budget.links += 1
	if (budget.links > MAX_LINKS) throw invalid('Standard Page link budget exceeded')
	const target = object(record.target, `${label}.target`)
	if (target.kind === 'fragment') {
		keys(target, `${label}.target`, ['kind', 'anchor'])
		const anchor = pattern(target.anchor, `${label}.target.anchor`, ANCHOR)
		budget.fragments.push(anchor)
		return Object.freeze({
			type: 'link',
			target: Object.freeze({ kind: 'fragment', anchor }),
			children: inlines(record.children, budget, depth + 1, `${label}.children`),
		})
	}
	if (target.kind !== 'https' && target.kind !== 'mailto') {
		throw invalid(`${label}.target.kind is unsupported`)
	}
	keys(target, `${label}.target`, ['kind', 'href'])
	const href = text(target.href, `${label}.target.href`)
	if (href.length > 2_048 || hasAsciiControl(href)) {
		throw invalid(`${label}.target.href is invalid`)
	}
	let protocol: string
	try {
		protocol = new URL(href).protocol
	} catch {
		throw invalid(`${label}.target.href is invalid`)
	}
	if (protocol !== `${target.kind}:`) throw invalid(`${label}.target.href has the wrong protocol`)
	return Object.freeze({
		type: 'link',
		target: Object.freeze({ kind: target.kind, href }),
		children: inlines(record.children, budget, depth + 1, `${label}.children`),
	})
}

function object(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw invalid(`${label} must be an object`)
	}
	return input as Record<string, unknown>
}

function exact(input: unknown, label: string, expected: readonly string[]) {
	const record = object(input, label)
	keys(record, label, expected)
	return record
}

function keys(record: Record<string, unknown>, label: string, expected: readonly string[]) {
	const actual = Object.keys(record).sort()
	const canonical = [...expected].sort()
	if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
		throw invalid(`${label} has unsupported or missing fields`)
	}
}

function optionalKeys(
	record: Record<string, unknown>,
	label: string,
	required: readonly string[],
	optional: readonly string[],
) {
	const actual = Object.keys(record)
	const allowed = new Set([...required, ...optional])
	if (
		required.some((key) => !Object.hasOwn(record, key)) ||
		actual.some((key) => !allowed.has(key))
	) {
		throw invalid(`${label} has unsupported or missing fields`)
	}
}

function pageKey(input: unknown, label: string): string {
	const value = text(input, label)
	if (!ENTRY_KEY.test(value) || RESERVED_ENTRY_KEYS.has(value)) throw invalid(`${label} is invalid`)
	return value
}

function digest(input: unknown, label: string): string {
	const value = text(input, label)
	if (!SHA256.test(value)) throw invalid(`${label} is invalid`)
	return value
}

function pattern(input: unknown, label: string, expected: RegExp): string {
	const value = text(input, label)
	if (!expected.test(value)) throw invalid(`${label} is invalid`)
	return value
}

function text(input: unknown, label: string): string {
	if (typeof input !== 'string') throw invalid(`${label} must be a string`)
	return input
}

function hasAsciiControl(input: string): boolean {
	for (let index = 0; index < input.length; index += 1) {
		const code = input.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}

function positiveInteger(input: unknown, label: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 1) throw invalid(`${label} is invalid`)
	return input as number
}

function nodeBudget(budget: Budget) {
	budget.nodes += 1
	if (budget.nodes > MAX_NODES) throw invalid('Standard Page node budget exceeded')
}

function textBudget(budget: Budget, value: string) {
	budget.textBytes += bytes(value)
	if (budget.textBytes > MAX_TEXT_BYTES) throw invalid('Standard Page text budget exceeded')
}

function depthBudget(depth: number) {
	if (depth > MAX_DEPTH) throw invalid('Standard Page depth budget exceeded')
}

function assertSerializedBudget(input: unknown, label: string) {
	if (bytes(JSON.stringify(input)) > MAX_SERIALIZED_BYTES)
		throw invalid(`${label} exceeds its byte budget`)
}

function bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

function invalid(message: string): TypeError {
	return new TypeError(`[pluxel/core/workbench-page] ${message}`)
}
