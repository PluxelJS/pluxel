import { expect, it } from 'vitest'
import { parsePluginDefinitionAddress } from '../../src'
import {
	WORKBENCH_FEDERATION_SHARED_MODULES,
	assertWorkbenchFederationSnapshotContract,
	createWorkbenchFederationCompatibilitySet,
	createWorkbenchFederationDeploymentInventory,
	createWorkbenchFederationProducerPlan,
	parseWorkbenchDeclarationIdentity,
	parseWorkbenchFederationDeploymentInventory,
	parseWorkbenchFederationManifestContract,
	parseWorkbenchOpenableIdentity,
	workbenchDeclarationIdentityEqual,
	workbenchFederationBuildOutDir,
	workbenchFederationDeploymentInventoryPath,
	workbenchOpenableIdentityEqual,
} from '../../src/federation'

const provider = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/fonts' },
	exportName: 'FontManagerPlugin',
})
const consumer = parsePluginDefinitionAddress({
	entry: { kind: 'source-entry', sourceSpace: 'app', path: 'src/canvas.ts' },
	exportName: 'CanvasPlugin',
})
const manager = { kind: 'view', owner: provider, key: 'manager' } as const
const picker = { kind: 'attachment', owner: provider, key: 'collectionPicker' } as const

it('keeps View, Content and nested Attachment placement identities distinct across the wire', () => {
	const placement = {
		kind: 'attachment-placement',
		consumer,
		key: 'fonts',
		provider: picker,
	} as const
	const parsed = parseWorkbenchOpenableIdentity(JSON.parse(JSON.stringify(placement)))
	expect(parsed).toEqual(placement)
	expect(workbenchOpenableIdentityEqual(parsed, placement)).toBe(true)
	if (parsed.kind !== 'attachment-placement') throw new Error('Expected an Attachment placement')
	expect(Object.isFrozen(parsed)).toBe(true)
	expect(Object.isFrozen(parsed.provider)).toBe(true)

	const view = parseWorkbenchDeclarationIdentity(JSON.parse(JSON.stringify(manager)))
	expect(workbenchDeclarationIdentityEqual(view, manager)).toBe(true)
	expect(workbenchDeclarationIdentityEqual(view, { ...manager, key: 'managerV2' })).toBe(false)
	const content = parseWorkbenchOpenableIdentity({ ...manager, kind: 'content' })
	expect(content).toEqual({ ...manager, kind: 'content' })
	expect(Object.isFrozen(content)).toBe(true)
	expect(workbenchOpenableIdentityEqual(content, { ...manager, kind: 'content' })).toBe(true)
	expect(workbenchOpenableIdentityEqual(content, manager)).toBe(false)
	expect(() => parseWorkbenchDeclarationIdentity(content)).toThrow('view or attachment')
})

it('rejects extra or reserved identity fields and declarations without an openable address', () => {
	expect(() => parseWorkbenchDeclarationIdentity({ ...manager, extra: true })).toThrow(
		'must contain exactly',
	)
	expect(() => parseWorkbenchDeclarationIdentity({ ...manager, key: 'then' })).toThrow(
		'not be reserved',
	)
	for (const identity of [picker, { ...manager, kind: 'page' }]) {
		expect(() => parseWorkbenchOpenableIdentity(identity)).toThrow(
			'view, content, or attachment-placement',
		)
	}
})

const managerEntry = { descriptor: manager, bridgeEntryPath: 'generated/manager.tsx' }
const pickerEntry = { descriptor: picker, bridgeEntryPath: 'generated/collection-picker.tsx' }
const input = {
	definition: provider,
	buildRevision: 'revision-a',
	entries: [managerEntry, pickerEntry],
}
const plan = createWorkbenchFederationProducerPlan(input)

it('keeps one producer across source moves and revisions and derives sorted Bridge exposes', () => {
	expect(plan.entries.map(({ expose }) => expose)).toEqual([
		'./views/collectionPicker',
		'./views/manager',
	])
	expect(Object.isFrozen(plan.entries)).toBe(true)
	expect(plan.producer).toMatch(/^pluxel_workbench_[a-f0-9]{32}$/)
	const moved = createWorkbenchFederationProducerPlan({
		...input,
		buildRevision: 'revision-b',
		entries: [pickerEntry, { ...managerEntry, bridgeEntryPath: 'moved/manager.tsx' }],
	})
	expect(moved.producer).toBe(plan.producer)
	expect(workbenchFederationBuildOutDir(moved)).toBe(`dist/workbench/${plan.producer}/revision-b`)
})

it('rejects invalid producer ownership, ambiguous exposes, extra fields and escaping paths', () => {
	for (const [change, message] of [
		[
			{ entries: [{ ...managerEntry, descriptor: { ...manager, owner: consumer } }] },
			'different Plugin definition',
		],
		[
			{ entries: [managerEntry, { ...pickerEntry, descriptor: { ...picker, key: manager.key } }] },
			'duplicate Workbench entry key',
		],
		[{ extra: true }, 'must contain exactly'],
		[{ entries: [{ ...managerEntry, expose: './views/manager' }] }, 'must contain exactly'],
		[
			{ entries: [{ ...managerEntry, bridgeEntryPath: '../manager.tsx' }] },
			'normalized relative path',
		],
	] as const) {
		expect(() => createWorkbenchFederationProducerPlan({ ...input, ...change } as never)).toThrow(
			message,
		)
	}
	expect(() => workbenchFederationBuildOutDir(plan, '/absolute')).toThrow(
		'build root must be relative',
	)
})

it('round-trips the producer inventory at its canonical deployment path', () => {
	const inventory = createWorkbenchFederationDeploymentInventory([plan])
	expect(inventory).toEqual({
		version: 1,
		profile: 1,
		buildContract: 3,
		producers: [{ plan, artifactRoot: `workbench/${plan.producer}/revision-a` }],
	})
	expect(workbenchFederationDeploymentInventoryPath()).toBe(
		'dist/workbench/pluxel-workbench-producers.json',
	)
	expect(
		parseWorkbenchFederationDeploymentInventory(JSON.parse(JSON.stringify(inventory))),
	).toEqual(inventory)
	expect(() =>
		parseWorkbenchFederationDeploymentInventory({
			...inventory,
			producers: [{ ...inventory.producers[0], artifactRoot: '../escape' }],
		}),
	).toThrow('normalized relative path')
})

const compatibility = createWorkbenchFederationCompatibilitySet({
	react: '19.3.0',
	reactDom: '19.3.0',
	workbench: '1.0.0',
})
const runtimeFiles = ['mf-manifest.json', 'remoteEntry.js', 'assets/view-0.js', 'assets/view-1.js']
const types = { api: 'types/index.d.ts', zip: '@mf-types.zip' }

function assets(js: string[] = []) {
	return { js: { sync: js, async: [] }, css: { sync: [], async: [] } } as const
}
const manifest = {
	id: plan.producer,
	name: plan.producer,
	metaData: {
		name: plan.producer,
		publicPath: 'auto',
		remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
	},
	shared: WORKBENCH_FEDERATION_SHARED_MODULES.map((name) => ({
		name,
		version: compatibility.shared[name],
		requiredVersion: compatibility.shared[name],
		singleton: true,
		assets: assets(),
	})),
	exposes: plan.entries.map(({ expose }, index) => ({
		name: expose.slice(2),
		path: expose.slice(2),
		assets: assets([`assets/view-${index}.js`]),
	})),
}
const deployedManifest = { ...manifest, metaData: { ...manifest.metaData, types } }

it('loads the exact singleton inventory and returns its authoritative files', () => {
	const { files } = parseWorkbenchFederationManifestContract(deployedManifest, {
		plan,
		compatibility,
	})
	expect([...files].sort()).toEqual([...runtimeFiles, types.api, types.zip].sort())

	const [first, ...others] = manifest.shared
	for (const [shared, message] of [
		[others, 'shared inventory mismatch'],
		[[...manifest.shared, { ...first!, name: 'unexpected-shared' }], 'shared inventory mismatch'],
		[[{ ...first!, requiredVersion: '0.0.0' }, ...others], 'expected exact singleton'],
	] as const) {
		expect(() =>
			parseWorkbenchFederationManifestContract(
				{ ...deployedManifest, shared },
				{ plan, compatibility },
			),
		).toThrow(message)
	}
})

it('allows runtime-only manifests in development and requires both type files for deployment', () => {
	const incomplete = { ...manifest.metaData, types: { api: types.api } }
	for (const metaData of [
		manifest.metaData,
		{ ...manifest.metaData, types: { api: '', zip: '' } },
		incomplete,
	]) {
		const { files } = parseWorkbenchFederationManifestContract(
			{ ...manifest, metaData },
			{ plan, compatibility, typeAssets: 'optional' },
		)
		expect([...files].sort()).toEqual([...runtimeFiles].sort())
	}
	expect(() =>
		parseWorkbenchFederationManifestContract(
			{ ...manifest, metaData: incomplete },
			{ plan, compatibility, typeAssets: 'required' },
		),
	).toThrow('federation manifest type asset is invalid: zip')
})

it('requires Snapshot modules to match the producer exposes exactly', () => {
	const modules = plan.entries.map(({ expose }) => ({ moduleName: expose.slice(2) }))
	expect(() => assertWorkbenchFederationSnapshotContract({ modules }, plan)).not.toThrow()
	for (const [changed, message] of [
		[modules.slice(1), 'Snapshot module inventory mismatch'],
		[[...modules, { moduleName: 'views/unexpected' }], 'Snapshot module inventory mismatch'],
		[[...modules, modules[0]], 'Snapshot contains an invalid module'],
	] as const) {
		expect(() => assertWorkbenchFederationSnapshotContract({ modules: changed }, plan)).toThrow(
			message,
		)
	}
})
