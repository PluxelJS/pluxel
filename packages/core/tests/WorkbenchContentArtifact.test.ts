import { describe, expect, it } from 'vitest'
import { parsePluginDefinitionAddress } from '../src'
import {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	WORKBENCH_CONTENT_ARTIFACT_ROOT,
	WORKBENCH_CONTENT_ARTIFACT_VERSION,
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchContentDeploymentInventory,
	createWorkbenchContentSet,
	parseWorkbenchContentDeploymentInventory,
	parseWorkbenchContentPlan,
	parseWorkbenchContentSet,
	serializeWorkbenchContentSet,
	workbenchContentArtifactRoot,
} from '../src/internal'

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/redis' },
	exportName: 'RedisPlugin',
})

const content = {
	version: 1,
	kind: 'workbench-content',
	document: {
		version: 1,
		blocks: [
			{ type: 'heading', level: 1, anchor: 'redis', children: [{ type: 'text', value: 'Redis' }] },
			{
				type: 'paragraph',
				children: [
					{
						type: 'link',
						target: { kind: 'fragment', anchor: 'redis' },
						children: [{ type: 'text', value: 'Overview' }],
					},
				],
			},
		],
	},
	slots: [],
} as const

describe('Workbench Content artifact contract', () => {
	it('pins the wire names and numeric version', () => {
		expect(WORKBENCH_CONTENT_ARTIFACT_VERSION).toBe(1)
		expect(WORKBENCH_CONTENT_ARTIFACT_ROOT).toBe('content')
		expect(WORKBENCH_CONTENT_ARTIFACT_FILE).toBe('content-plan.json')
		expect(WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE).toBe('pluxel-workbench-content.json')
	})

	it('canonicalizes a sorted immutable content set', () => {
		const set = createWorkbenchContentSet({
			definition,
			entries: [{ key: 'guide', content }],
		})
		expect(set.entries[0]?.content).toEqual(content)
		expect(Object.isFrozen(set.entries)).toBe(true)
		expect(Object.isFrozen(set.entries[0]?.content.document.blocks)).toBe(true)
		expect(serializeWorkbenchContentSet(set)).toBe(`${JSON.stringify(set)}\n`)
	})

	it('canonicalizes exact data and action slot topology', () => {
		const plan = parseWorkbenchContentPlan({
			...content,
			document: {
				version: 1,
				blocks: [
					{
						type: 'paragraph',
						children: [
							{ type: 'text', value: 'Status: ' },
							{ type: 'slot', key: 'status' },
						],
					},
					{ type: 'slot', key: 'clear' },
				],
			},
			slots: [
				{
					kind: 'action',
					key: 'clear',
					display: 'block',
					label: 'Clear cache',
					input: 'none',
					confirm: 'This cannot be undone.',
				},
				{ kind: 'data', key: 'status', display: 'inline' },
			],
		})

		expect(plan.slots.map((slot) => slot.key)).toEqual(['clear', 'status'])
		expect(Object.isFrozen(plan.slots)).toBe(true)
		expect(Object.isFrozen(plan.document.blocks[1])).toBe(true)
	})

	it('rejects invalid or ambiguous slot topology', () => {
		const inlineNode = {
			version: 1,
			blocks: [{ type: 'paragraph', children: [{ type: 'slot', key: 'status' }] }],
		}
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: inlineNode,
				slots: [{ kind: 'data', key: 'status', display: 'block' }],
			}),
		).toThrow('display does not match')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: inlineNode,
				slots: [
					{
						kind: 'action',
						key: 'status',
						display: 'inline',
						label: 'Refresh',
						input: 'none',
					},
				],
			}),
		).toThrow('display must be block')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: {
					version: 1,
					blocks: [
						{ type: 'slot', key: 'status' },
						{ type: 'slot', key: 'status' },
					],
				},
				slots: [{ kind: 'data', key: 'status', display: 'block' }],
			}),
		).toThrow('must appear exactly once')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: { version: 1, blocks: [{ type: 'slot', key: 'missing' }] },
				slots: [],
			}),
		).toThrow('is undeclared')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				slots: [{ kind: 'data', key: 'status', display: 'block' }],
			}),
		).toThrow('has no document node')
		const { slots: _slots, ...planWithoutSlots } = content
		expect(() => parseWorkbenchContentPlan(planWithoutSlots)).toThrow(
			'unsupported or missing fields',
		)
	})

	it('requires sorted slot keys and bounded action text', () => {
		const blockNodes = {
			version: 1,
			blocks: [
				{ type: 'slot', key: 'alpha' },
				{ type: 'slot', key: 'zulu' },
			],
		}
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: blockNodes,
				slots: [
					{ kind: 'data', key: 'zulu', display: 'block' },
					{ kind: 'data', key: 'alpha', display: 'block' },
				],
			}),
		).toThrow('unique sorted keys')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: { version: 1, blocks: [{ type: 'slot', key: 'submit' }] },
				slots: [
					{
						kind: 'action',
						key: 'submit',
						display: 'block',
						label: 'x'.repeat(129),
						input: 'dialog',
					},
				],
			}),
		).toThrow('.label is invalid')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: { version: 1, blocks: [{ type: 'slot', key: 'submit' }] },
				slots: [
					{
						kind: 'action',
						key: 'submit',
						display: 'block',
						label: 'Submit',
						input: 'dialog',
						confirm: 'x'.repeat(1_025),
					},
				],
			}),
		).toThrow('.confirm is invalid')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: { version: 1, blocks: [{ type: 'slot', key: 'submit' }] },
				slots: [
					{
						kind: 'action',
						key: 'submit',
						display: 'block',
						label: 'Submit',
						input: 'popover',
					},
				],
			}),
		).toThrow('.input is invalid')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: { version: 1, blocks: [{ type: 'slot', key: 'then' }] },
				slots: [{ kind: 'data', key: 'then', display: 'block' }],
			}),
		).toThrow('.key is invalid')
	})

	it('rejects the removed Page wire contract', () => {
		expect(() => parseWorkbenchContentPlan({ ...content, kind: 'standard-page' })).toThrow(
			'version or kind is unsupported',
		)
		expect(() =>
			parseWorkbenchContentSet({
				version: 1,
				kind: 'workbench-content-set',
				definition,
				entries: [{ key: 'guide', page: content }],
			}),
		).toThrow('unsupported or missing fields')
	})

	it('rejects unsafe content and broken fragments', () => {
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: {
					version: 1,
					blocks: [{ type: 'html', value: '<script />' }],
				},
			}),
		).toThrow('type is unsupported')
		expect(() =>
			parseWorkbenchContentPlan({
				...content,
				document: {
					version: 1,
					blocks: [
						{
							type: 'paragraph',
							children: [
								{
									type: 'link',
									target: { kind: 'fragment', anchor: 'missing' },
									children: [],
								},
							],
						},
					],
				},
			}),
		).toThrow('does not name a heading')
	})

	it('pins deployment entries to canonical immutable roots', () => {
		const definitionDigest = 'a'.repeat(64)
		const digest = 'b'.repeat(64)
		const artifactRoot = workbenchContentArtifactRoot(definitionDigest, digest)
		const inventory = createWorkbenchContentDeploymentInventory([
			{ definition, definitionDigest, digest, artifactRoot },
		])
		expect(inventory.entries[0]?.artifactRoot).toBe(`content/${definitionDigest}/${digest}`)
		expect(() =>
			parseWorkbenchContentDeploymentInventory({
				...inventory,
				entries: [{ ...inventory.entries[0], artifactRoot: '../escape' }],
			}),
		).toThrow('non-canonical')
	})
})
