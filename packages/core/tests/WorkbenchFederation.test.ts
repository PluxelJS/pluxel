import { describe, expect, it } from 'vitest'
import { parsePluginDefinitionAddress } from '../src'
import {
	WORKBENCH_FEDERATION_SHARED_MODULES,
	assertWorkbenchFederationSnapshotContract,
	createWorkbenchFederationCompatibilitySet,
	createWorkbenchFederationDeploymentInventory,
	createWorkbenchFederationProducerPlan,
	parseWorkbenchFederationDeploymentInventory,
	parseWorkbenchFederationManifestContract,
	parseWorkbenchDeclarationIdentity,
	parseWorkbenchOpenableIdentity,
	workbenchDeclarationIdentityEqual,
	workbenchFederationBuildOutDir,
	workbenchFederationDeploymentInventoryPath,
	workbenchOpenableIdentityEqual,
} from '../src/federation'

const provider = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/fonts' },
	exportName: 'FontManagerPlugin',
})
const consumer = parsePluginDefinitionAddress({
	entry: { kind: 'source-entry', sourceSpace: 'app', path: 'src/canvas.ts' },
	exportName: 'CanvasPlugin',
})

describe('Workbench federation identities', () => {
	it('parses exact declaration and nested Attachment placement identities', () => {
		const attachment = parseWorkbenchDeclarationIdentity({
			kind: 'attachment',
			owner: provider,
			key: 'collectionPicker',
		})
		const placement = parseWorkbenchOpenableIdentity({
			kind: 'attachment-placement',
			consumer,
			key: 'fonts',
			provider: attachment,
		})

		expect(placement).toEqual({
			kind: 'attachment-placement',
			consumer,
			key: 'fonts',
			provider: attachment,
		})
		expect(Object.isFrozen(placement)).toBe(true)
		if (placement.kind !== 'attachment-placement') throw new Error('expected Attachment placement')
		expect(Object.isFrozen(placement.provider)).toBe(true)
		expect(
			workbenchOpenableIdentityEqual(placement, {
				kind: 'attachment-placement',
				consumer: parsePluginDefinitionAddress({ ...consumer }),
				key: 'fonts',
				provider: {
					kind: 'attachment',
					owner: parsePluginDefinitionAddress({ ...provider }),
					key: 'collectionPicker',
				},
			}),
		).toBe(true)
	})

	it('keeps Content openable identity outside the federation declaration union', () => {
		const content = parseWorkbenchOpenableIdentity({
			kind: 'content',
			owner: provider,
			key: 'guide',
		})
		expect(content).toEqual({ kind: 'content', owner: provider, key: 'guide' })
		expect(Object.isFrozen(content)).toBe(true)
		expect(
			workbenchOpenableIdentityEqual(content, {
				kind: 'content',
				owner: parsePluginDefinitionAddress({ ...provider }),
				key: 'guide',
			}),
		).toBe(true)
		expect(
			workbenchOpenableIdentityEqual(content, {
				kind: 'view',
				owner: provider,
				key: 'guide',
			}),
		).toBe(false)
		expect(() => parseWorkbenchDeclarationIdentity(content)).toThrow('view or attachment')
	})

	it('rejects malformed, extra, reserved, and non-openable identities', () => {
		expect(() =>
			parseWorkbenchDeclarationIdentity({
				kind: 'view',
				owner: provider,
				key: 'manager',
				extra: true,
			}),
		).toThrow('must contain exactly')
		expect(() =>
			parseWorkbenchDeclarationIdentity({ kind: 'view', owner: provider, key: 'then' }),
		).toThrow('not be reserved')
		expect(() =>
			parseWorkbenchOpenableIdentity({
				kind: 'attachment',
				owner: provider,
				key: 'collectionPicker',
			}),
		).toThrow('view, content, or attachment-placement')
		expect(() =>
			parseWorkbenchOpenableIdentity({ kind: 'page', owner: provider, key: 'guide' }),
		).toThrow('view, content, or attachment-placement')
	})

	it('compares identities field by field', () => {
		const manager = parseWorkbenchDeclarationIdentity({
			kind: 'view',
			owner: provider,
			key: 'manager',
		})
		const renamed = parseWorkbenchDeclarationIdentity({
			kind: 'view',
			owner: provider,
			key: 'managerV2',
		})
		expect(workbenchDeclarationIdentityEqual(manager, manager)).toBe(true)
		expect(workbenchDeclarationIdentityEqual(manager, renamed)).toBe(false)
	})
})

describe('Workbench federation producer plan', () => {
	it('derives one stable producer with sorted per-entry Bridge exposes', () => {
		const plan = createWorkbenchFederationProducerPlan({
			definition: provider,
			buildRevision: 'b-a1b2c3',
			entries: [
				{
					descriptor: { kind: 'attachment', owner: provider, key: 'collectionPicker' },
					bridgeEntryPath: 'generated/collection-picker.tsx',
				},
				{
					descriptor: { kind: 'view', owner: provider, key: 'manager' },
					bridgeEntryPath: 'generated/manager.tsx',
				},
			],
		})

		expect(plan.entries.map((entry) => entry.expose)).toEqual([
			'./views/collectionPicker',
			'./views/manager',
		])
		expect(plan.producer).toMatch(/^pluxel_workbench_[a-f0-9]{32}$/)
		expect(workbenchFederationBuildOutDir(plan)).toBe(`dist/workbench/${plan.producer}/b-a1b2c3`)
		expect(Object.isFrozen(plan.entries)).toBe(true)
	})

	it('keeps source provenance and build revision out of producer identity', () => {
		const create = (buildRevision: string, bridgeEntryPath: string) =>
			createWorkbenchFederationProducerPlan({
				definition: provider,
				buildRevision,
				entries: [
					{
						descriptor: { kind: 'view', owner: provider, key: 'manager' },
						bridgeEntryPath,
					},
				],
			})
		expect(create('revision-a', 'a.tsx').producer).toBe(
			create('revision-b', 'moved/b.tsx').producer,
		)
	})

	it('rejects descriptors owned by another definition and duplicate flat keys', () => {
		expect(() =>
			createWorkbenchFederationProducerPlan({
				definition: provider,
				buildRevision: 'revision-a',
				entries: [
					{
						descriptor: { kind: 'view', owner: consumer, key: 'manager' },
						bridgeEntryPath: 'manager.tsx',
					},
				],
			}),
		).toThrow('different Plugin definition')
		expect(() =>
			createWorkbenchFederationProducerPlan({
				definition: provider,
				buildRevision: 'revision-a',
				entries: [
					{
						descriptor: { kind: 'view', owner: provider, key: 'manager' },
						bridgeEntryPath: 'manager.tsx',
					},
					{
						descriptor: { kind: 'attachment', owner: provider, key: 'manager' },
						bridgeEntryPath: 'picker.tsx',
					},
				],
			}),
		).toThrow('duplicate Workbench entry key')
	})

	it('rejects extra plan fields, extra entry fields, and non-portable paths', () => {
		const entry = {
			descriptor: { kind: 'view' as const, owner: provider, key: 'manager' },
			bridgeEntryPath: 'generated/manager.tsx',
		}
		expect(() =>
			createWorkbenchFederationProducerPlan({
				definition: provider,
				buildRevision: 'revision-a',
				entries: [entry],
				extra: true,
			} as never),
		).toThrow('must contain exactly')
		expect(() =>
			createWorkbenchFederationProducerPlan({
				definition: provider,
				buildRevision: 'revision-a',
				entries: [{ ...entry, expose: './views/manager' }],
			} as never),
		).toThrow('must contain exactly')
		expect(() =>
			createWorkbenchFederationProducerPlan({
				definition: provider,
				buildRevision: 'revision-a',
				entries: [{ ...entry, bridgeEntryPath: '../manager.tsx' }],
			}),
		).toThrow('normalized relative path')
		expect(() =>
			workbenchFederationBuildOutDir(
				createWorkbenchFederationProducerPlan({
					definition: provider,
					buildRevision: 'revision-a',
					entries: [entry],
				}),
				'/absolute',
			),
		).toThrow('build root must be relative')
	})

	it('creates and parses one exact sorted host deployment inventory', () => {
		const plan = createWorkbenchFederationProducerPlan({
			definition: provider,
			buildRevision: 'revision-a',
			entries: [
				{
					descriptor: { kind: 'view', owner: provider, key: 'manager' },
					bridgeEntryPath: 'generated/manager.tsx',
				},
			],
		})
		const inventory = createWorkbenchFederationDeploymentInventory([plan])
		expect(inventory).toEqual({
			version: 1,
			profile: 1,
			buildContract: 2,
			producers: [
				{
					plan,
					artifactRoot: `workbench/${plan.producer}/revision-a`,
				},
			],
		})
		expect(
			parseWorkbenchFederationDeploymentInventory(JSON.parse(JSON.stringify(inventory))),
		).toEqual(inventory)
		expect(workbenchFederationDeploymentInventoryPath()).toBe(
			'dist/workbench/pluxel-workbench-producers.json',
		)
		expect(() =>
			parseWorkbenchFederationDeploymentInventory({
				...inventory,
				producers: [{ ...inventory.producers[0], artifactRoot: '../escape' }],
			}),
		).toThrow('normalized relative path')
	})
})

describe('Workbench federation Profile 1 artifact contract', () => {
	const compatibility = createWorkbenchFederationCompatibilitySet({
		react: '19.2.8',
		reactDom: '19.2.8',
		runtime: '1.0.0',
	})
	const plan = createWorkbenchFederationProducerPlan({
		definition: provider,
		buildRevision: 'revision-a',
		entries: [
			{
				descriptor: { kind: 'view', owner: provider, key: 'manager' },
				bridgeEntryPath: 'generated/manager.tsx',
			},
			{
				descriptor: { kind: 'attachment', owner: provider, key: 'collectionPicker' },
				bridgeEntryPath: 'generated/collection-picker.tsx',
			},
		],
	})

	function assetGroup(js: string[] = []) {
		return {
			js: { sync: js, async: [] as string[] },
			css: { sync: [] as string[], async: [] as string[] },
		}
	}

	function manifest() {
		return {
			id: plan.producer,
			name: plan.producer,
			metaData: {
				name: plan.producer,
				publicPath: 'auto',
				remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
				types: { api: 'types/index.d.ts', zip: '@mf-types.zip' },
			},
			shared: WORKBENCH_FEDERATION_SHARED_MODULES.map((name) => ({
				name,
				version: compatibility.shared[name],
				requiredVersion: compatibility.shared[name],
				singleton: true,
				assets: assetGroup(),
			})),
			exposes: plan.entries.map((entry, index) => ({
				name: entry.expose.slice(2),
				path: entry.expose.slice(2),
				assets: assetGroup([`assets/view-${index}.js`]),
			})),
		}
	}

	it('accepts only the fixed exact shared inventory and returns its authoritative files', () => {
		const contract = parseWorkbenchFederationManifestContract(manifest(), {
			plan,
			compatibility,
		})
		expect(contract.files).toEqual(
			expect.arrayContaining([
				'mf-manifest.json',
				'remoteEntry.js',
				'assets/view-0.js',
				'assets/view-1.js',
				'types/index.d.ts',
				'@mf-types.zip',
			]),
		)

		const missing = manifest()
		missing.shared.pop()
		expect(() =>
			parseWorkbenchFederationManifestContract(missing, { plan, compatibility }),
		).toThrow('shared inventory mismatch')
		const extra = manifest()
		extra.shared.push({
			...extra.shared[0]!,
			name: 'unexpected-shared' as never,
		})
		expect(() => parseWorkbenchFederationManifestContract(extra, { plan, compatibility })).toThrow(
			'shared inventory mismatch',
		)
		const wrongVersion = manifest()
		wrongVersion.shared[0]!.requiredVersion = '0.0.0'
		expect(() =>
			parseWorkbenchFederationManifestContract(wrongVersion, { plan, compatibility }),
		).toThrow('expected exact singleton')
	})

	it('rejects Snapshot module inventories that do not exactly match the producer plan', () => {
		const validModules = plan.entries.map((entry) => ({ moduleName: entry.expose.slice(2) }))
		expect(() =>
			assertWorkbenchFederationSnapshotContract({ modules: validModules }, plan),
		).not.toThrow()
		expect(() =>
			assertWorkbenchFederationSnapshotContract({ modules: validModules.slice(1) }, plan),
		).toThrow('Snapshot module inventory mismatch')
		expect(() =>
			assertWorkbenchFederationSnapshotContract(
				{ modules: [...validModules, { moduleName: 'views/unexpected' }] },
				plan,
			),
		).toThrow('Snapshot module inventory mismatch')
		expect(() =>
			assertWorkbenchFederationSnapshotContract(
				{ modules: [...validModules, validModules[0]] },
				plan,
			),
		).toThrow('Snapshot contains an invalid module')
	})
})
