import { expect, it } from 'vitest'
import { parsePluginDefinitionAddress } from '../../src'
import {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchContentDeploymentInventory,
	createWorkbenchContentSet,
	parseWorkbenchContentDeploymentInventory,
	parseWorkbenchContentPlan,
	parseWorkbenchContentSet,
	serializeWorkbenchContentSet,
	workbenchContentArtifactRoot,
} from '../../src/internal'

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/redis' },
	exportName: 'RedisPlugin',
})
const clear = {
	kind: 'action',
	key: 'clear',
	display: 'block',
	label: 'Clear cache',
	input: 'none',
	confirm: 'This cannot be undone.',
} as const
const status = { kind: 'data', key: 'status', display: 'inline' } as const
const overviewLink = {
	type: 'link',
	target: { kind: 'fragment', anchor: 'redis' },
	children: [{ type: 'text', value: 'Overview' }],
} as const
const summary = {
	type: 'paragraph',
	children: [overviewLink, { type: 'slot', key: 'status' }],
} as const
const button = { type: 'slot', key: 'clear' } as const
const content = {
	version: 1,
	kind: 'workbench-content',
	document: {
		version: 1,
		blocks: [
			{ type: 'heading', level: 1, anchor: 'redis', children: [{ type: 'text', value: 'Redis' }] },
			summary,
			button,
		],
	},
	slots: [clear, status],
} as const

it('round-trips a guide with its inline status and block action through the Content file', () => {
	const set = createWorkbenchContentSet({ definition, entries: [{ key: 'guide', content }] })
	const serialized = serializeWorkbenchContentSet(set)
	expect(WORKBENCH_CONTENT_ARTIFACT_FILE).toBe('content-plan.json')
	expect(serialized).toBe(`${JSON.stringify(set)}\n`)

	const loaded = parseWorkbenchContentSet(JSON.parse(serialized))
	expect(loaded).toMatchObject({ version: 1, entries: [{ key: 'guide', content }] })
	const plan = loaded.entries[0]!.content
	expect(Object.isFrozen(loaded.entries)).toBe(true)
	expect(Object.isFrozen(plan.document.blocks)).toBe(true)
	expect(Object.isFrozen(plan.document.blocks[2])).toBe(true)
	expect(Object.isFrozen(plan.slots)).toBe(true)

	for (const entry of [{ key: 'guide' }, { key: 'guide', content, extra: true }]) {
		expect(() => parseWorkbenchContentSet({ ...loaded, entries: [entry] })).toThrow(
			'unsupported or missing fields',
		)
	}
})

it('rejects slot declarations that disagree with the document', () => {
	const { document } = content
	for (const [change, message] of [
		[{ slots: [clear, { ...status, display: 'block' }] }, 'display does not match'],
		[{ slots: [clear, { ...clear, key: 'status', display: 'inline' }] }, 'display must be block'],
		[
			{ document: { ...document, blocks: [...document.blocks, button] } },
			'must appear exactly once',
		],
		[{ slots: [clear] }, 'is undeclared'],
		[{ document: { ...document, blocks: document.blocks.slice(0, -1) } }, 'has no document node'],
		[{ slots: [status, clear] }, 'unique sorted keys'],
	] as const) {
		expect(() => parseWorkbenchContentPlan({ ...content, ...change })).toThrow(message)
	}

	const { slots: _slots, ...withoutDeclarations } = content
	expect(() => parseWorkbenchContentPlan(withoutDeclarations)).toThrow(
		'unsupported or missing fields',
	)
})

it('rejects unsupported action input, oversized prompts and reserved keys', () => {
	for (const [slots, message] of [
		[[{ ...clear, label: 'x'.repeat(129) }, status], '.label is invalid'],
		[[{ ...clear, confirm: 'x'.repeat(1_025) }, status], '.confirm is invalid'],
		[[{ ...clear, input: 'popover' }, status], '.input is invalid'],
		[[clear, { ...status, key: 'then' }], '.key is invalid'],
	] as const) {
		expect(() => parseWorkbenchContentPlan({ ...content, slots })).toThrow(message)
	}
})

it('rejects unknown plan kinds, unsupported document blocks and unresolved fragments', () => {
	expect(() => parseWorkbenchContentPlan({ ...content, kind: 'unknown' })).toThrow(
		'version or kind is unsupported',
	)
	const [heading, ...body] = content.document.blocks
	for (const [block, message] of [
		[{ type: 'html', value: '<script />' }, 'type is unsupported'],
		[{ ...heading, anchor: 'unavailable' }, 'does not name a heading'],
	] as const) {
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: { ...content.document, blocks: [block, ...body] },
			}),
		).toThrow(message)
	}
})

it('pins deployment entries to canonical immutable roots', () => {
	const definitionDigest = 'a'.repeat(64)
	const digest = 'b'.repeat(64)
	const artifactRoot = workbenchContentArtifactRoot(definitionDigest, digest)
	const inventory = createWorkbenchContentDeploymentInventory([
		{ definition, definitionDigest, digest, artifactRoot },
	])
	expect(WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE).toBe('pluxel-workbench-content.json')
	expect(inventory.entries[0]?.artifactRoot).toBe(`content/${definitionDigest}/${digest}`)
	expect(parseWorkbenchContentDeploymentInventory(JSON.parse(JSON.stringify(inventory)))).toEqual(
		inventory,
	)
	expect(() =>
		parseWorkbenchContentDeploymentInventory({
			...inventory,
			entries: [{ ...inventory.entries[0], artifactRoot: '../escape' }],
		}),
	).toThrow('non-canonical')
})
