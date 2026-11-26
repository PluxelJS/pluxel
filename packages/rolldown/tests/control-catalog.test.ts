import { rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from 'fs-fixture'
import { expect, it } from 'vitest'
import { readControlCatalog } from '../src/control/inspect-catalog'
import { openControl } from '../src/control/inspection'
import {
	controlSha256,
	encodeControlData,
	renderControlCatalog,
	renderPluginDescriptors,
	type ControlCatalogEntry,
	type PluginControlManifest,
} from '../src/control/manifest'

const clockAddress = {
	entry: { kind: 'package-root', packageName: 'first' },
	exportName: 'Clock',
} as const

const clockService = {
	definition: clockAddress,
	module: 'service.mjs',
	exportName: 'ClockService',
	source: 'first/src/clock.ts',
	access: 'root',
	contract: `sha256:${controlSha256('service')}`,
} satisfies PluginControlManifest['services'][number]

function material(
	catalog?: string,
	options: {
		plugins?: readonly string[]
		services?: PluginControlManifest['services']
		serviceDeclaration?: string
	} = {},
) {
	const definitions = (options.plugins ?? ['first', 'second']).map<
		PluginControlManifest['definitions'][number]
	>((name) => ({
		definition: {
			entry: { kind: 'package-root', packageName: name },
			exportName: 'Clock',
		},
		exportName: name === 'first' ? 'Clock' : 'SecondClock',
		module: 'index.mjs',
		source: `${name}/src/clock.ts`,
		contracts: { config: null, instance: `sha256:${controlSha256(name)}` },
	}))
	const services = options.services ?? []
	const files = {
		...(catalog === undefined ? {} : { 'catalog.json': catalog }),
		...(definitions.length > 0 && {
			'index.mjs': renderPluginDescriptors(
				definitions.map(({ exportName, definition, contracts }) => ({
					exportName,
					descriptor: { format: 2, definition, contracts },
				})),
			),
			'index.d.mts':
				'export type ClockInstance = { now(): number }; export type SecondClockInstance = {}',
		}),
		...(services.length > 0 && {
			'service.mjs': renderPluginDescriptors(
				[],
				services.map(({ exportName, definition, access, contract }) => ({
					exportName,
					descriptor: { format: 1, definition, access, contract },
				})),
			),
			'service.d.mts':
				options.serviceDeclaration ??
				[
					'/** A single clock reading. */',
					'interface Reading { readonly unix: number }',
					'/** Shared clock. */',
					'export declare class ClockServiceInstance {',
					'  /** Read the current time. */',
					'  ctx(): Reading;',
					'  protected cache: Reading;',
					'}',
				].join('\n'),
		}),
	}
	const unsigned: Omit<PluginControlManifest, 'snapshot'> = {
		format: 3,
		compiler: 'typescript@test',
		definitions,
		services,
		files: Object.entries(files).map(([path, contents]) => ({
			path,
			size: Buffer.byteLength(contents),
			sha256: controlSha256(contents),
		})),
	}
	const manifest = { ...unsigned, snapshot: `sha256:${controlSha256(encodeControlData(unsigned))}` }
	return { ...files, 'manifest.json': `${encodeControlData(manifest)}\n` }
}

it('finds a member across plugins using only the verified catalog and manifest', async () => {
	const rows: ControlCatalogEntry[] = [
		{
			kind: 'plugin',
			reference: 'package:first::Clock',
			exportName: 'Clock',
			hasConfig: false,
			members: ['now'],
		},
		{
			kind: 'plugin',
			reference: 'package:second::Clock',
			exportName: 'SecondClock',
			hasConfig: false,
			members: [],
		},
	]
	const catalog = renderControlCatalog(rows)
	const files = material(catalog)
	await using fixture = await createFixture({
		'manifest.json': files['manifest.json'],
		'catalog.json': catalog,
	})
	using control = await openControl(fixture.path)
	expect(control.plugins.filter((plugin) => plugin.members?.includes('now'))).toEqual(
		rows.slice(0, 1),
	)
	await writeFile(join(fixture.path, 'catalog.json'), catalog.replace('"now"', '"new"'))
	await expect(openControl(fixture.path)).rejects.toThrow('integrity mismatch')
})

it('lists canonical definitions from the manifest alone and pins its declaration read across a current switch', async () => {
	const files = material()
	await using fixture = await createFixture({ 'snapshot/manifest.json': files['manifest.json'] })
	const snapshot = join(fixture.path, 'snapshot')
	const current = join(fixture.path, 'current')
	await symlink(snapshot, current, 'dir')
	const catalog = await readControlCatalog(current)
	expect(catalog.summaries.map(({ reference, exportName }) => [reference, exportName])).toEqual([
		['package:first::Clock', 'Clock'],
		['package:second::Clock', 'SecondClock'],
	])
	await rm(current)
	await symlink(fixture.path, current, 'dir')
	await writeFile(join(snapshot, 'index.d.mts'), files['index.d.mts']!)
	await writeFile(join(snapshot, 'index.mjs'), files['index.mjs']!)
	expect([...(await catalog.readDeclarations())]).toEqual([['index.d.mts', files['index.d.mts']!]])
})

it('rejects edited declaration bytes and symlinks to files outside the selected owner', async () => {
	const files = material()
	await using fixture = await createFixture({
		'control/index.d.mts': files['index.d.mts']!,
		'control/index.mjs': files['index.mjs']!,
		'control/manifest.json': files['manifest.json'],
	})
	const root = join(fixture.path, 'control')
	const declaration = join(root, 'index.d.mts')
	const outside = join(fixture.path, 'outside.d.mts')
	await rename(declaration, outside)
	await symlink(outside, declaration)
	const catalog = await readControlCatalog(root)
	await expect(catalog.readDeclarations()).rejects.toThrow('escapes its owner')
	await rm(declaration)
	await writeFile(declaration, files['index.d.mts']!.replace('number', 'string'))
	await expect(catalog.readDeclarations()).rejects.toThrow('integrity mismatch')
})

it('closes concurrent first inspections when their catalog is disposed', async () => {
	await using fixture = await createFixture(material())
	using catalog = await openControl(fixture.path)
	await expect(catalog.inspectConfig('package:first::Clock')).resolves.toBeNull()
	await expect(catalog.inspectConfig('package:missing::Clock')).rejects.toThrow(RangeError)
	const pending = catalog.inspectPlugin('package:first::Clock')
	const second = catalog.inspectPlugin('package:second::Clock')
	catalog[Symbol.dispose]()
	await Promise.all([
		expect(pending).rejects.toThrow('disposed'),
		expect(second).rejects.toThrow('disposed'),
		expect(catalog.inspectPlugin('package:first::Clock')).rejects.toThrow('disposed'),
	])
})

it('inspects a service-only material and resolves member DTOs from verified declarations', async () => {
	const reference = 'package:first::Clock'
	await using fixture = await createFixture(
		material(undefined, { plugins: [], services: [clockService] }),
	)
	using catalog = await openControl(fixture.path)
	expect(catalog.plugins).toEqual([])
	expect(catalog.services).toEqual([
		{ kind: 'service', reference, exportName: 'ClockService', access: 'root' },
	])
	const overview = await catalog.inspectService(reference)
	expect(overview.documentation).toBe('Shared clock.')
	expect(overview.members.map(({ name }) => name)).toEqual(['ctx'])
	expect(overview.types).toEqual([])
	const detail = await catalog.inspectService(clockAddress, { member: 'ctx' })
	expect(detail).toMatchObject({
		reference,
		access: 'root',
		importStatement: `import { ClockService } from ${JSON.stringify(join(fixture.path, 'service.mjs'))};`,
		members: [
			{
				name: 'ctx',
				kind: 'method',
				signatures: ['ctx(): Reading;'],
				documentation: 'Read the current time.',
			},
		],
		types: [
			{
				name: 'Reading',
				source: 'service.d.mts',
				line: 2,
				documentation: 'A single clock reading.',
			},
		],
		omittedTypes: [],
	})
	expect(detail.types[0]!.declaration).toContain('readonly unix: number')
	await expect(catalog.inspectService(reference, { member: 'cache' })).rejects.toThrow(
		'No public control member',
	)
	await expect(catalog.inspectPlugin(reference)).rejects.toThrow('Plugin is absent')
	await expect(catalog.inspectConfig(reference)).rejects.toThrow('Plugin is absent')
})

it('looks up each kind separately even when a plugin and a service share a reference', async () => {
	const reference = 'package:first::Clock'
	const rows = [
		{ kind: 'plugin', reference, exportName: 'Clock', hasConfig: false, members: ['now'] },
		{ kind: 'service', reference, exportName: 'ClockService', access: 'root', members: ['ctx'] },
	] satisfies ControlCatalogEntry[]
	await using fixture = await createFixture(
		material(renderControlCatalog(rows), { plugins: ['first'], services: [clockService] }),
	)
	using catalog = await openControl(fixture.path)
	expect(catalog.plugins).toEqual(rows.slice(0, 1))
	expect(catalog.services).toEqual(rows.slice(1))
	const [plugin, service] = await Promise.all([
		catalog.inspectPlugin(clockAddress),
		catalog.inspectService(clockAddress),
	])
	expect(plugin.members.map(({ name }) => name)).toEqual(['now'])
	expect(service.members.map(({ name }) => name)).toEqual(['ctx'])
	await expect(catalog.inspectService('package:second::Clock')).rejects.toThrow('Service is absent')
})

it('reports a missing Service instance declaration in otherwise valid material', async () => {
	await using fixture = await createFixture(
		material(undefined, { plugins: [], services: [clockService], serviceDeclaration: 'export {}' }),
	)
	using catalog = await openControl(fixture.path)
	await expect(catalog.inspectService(clockAddress)).rejects.toThrow(
		'Missing control export ClockServiceInstance',
	)
})
