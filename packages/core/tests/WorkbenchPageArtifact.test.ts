import { describe, expect, it } from 'vitest'
import { parsePluginDefinitionAddress } from '../src'
import {
	createWorkbenchPageDeploymentInventory,
	createWorkbenchPageSet,
	parseWorkbenchPageDeploymentInventory,
	parseWorkbenchStandardPagePlan,
	serializeWorkbenchPageSet,
	workbenchPageArtifactRoot,
} from '../src/internal'

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/redis' },
	exportName: 'RedisPlugin',
})

const page = {
	version: 1,
	kind: 'standard-page',
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
} as const

describe('Workbench Page artifact contract', () => {
	it('canonicalizes a sorted immutable page set', () => {
		const set = createWorkbenchPageSet({ definition, entries: [{ key: 'guide', page }] })
		expect(set.entries[0]?.page).toEqual(page)
		expect(Object.isFrozen(set.entries)).toBe(true)
		expect(Object.isFrozen(set.entries[0]?.page.document.blocks)).toBe(true)
		expect(serializeWorkbenchPageSet(set)).toBe(`${JSON.stringify(set)}\n`)
	})

	it('rejects unsafe content and broken fragments', () => {
		expect(() =>
			parseWorkbenchStandardPagePlan({
				...page,
				document: {
					version: 1,
					blocks: [{ type: 'html', value: '<script />' }],
				},
			}),
		).toThrow('type is unsupported')
		expect(() =>
			parseWorkbenchStandardPagePlan({
				...page,
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
		const artifactRoot = workbenchPageArtifactRoot(definitionDigest, digest)
		const inventory = createWorkbenchPageDeploymentInventory([
			{ definition, definitionDigest, digest, artifactRoot },
		])
		expect(inventory.pages[0]?.artifactRoot).toBe(`pages/${definitionDigest}/${digest}`)
		expect(() =>
			parseWorkbenchPageDeploymentInventory({
				...inventory,
				pages: [{ ...inventory.pages[0], artifactRoot: '../escape' }],
			}),
		).toThrow('non-canonical')
	})
})
