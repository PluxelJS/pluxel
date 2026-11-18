import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BasePlugin, Plugin } from '@pluxel/core'
import { expect, it } from 'vitest'
import { installedPackageFacts } from '../src/shared-packages'
import {
	recordLoadedPluginModule,
	readLoadedPluginModule,
	recordLoadedHostApplication,
	recordLoadedApplicationPlugins,
	readLoadedApplicationControl,
} from '../src/loaded-modules'
import { readHostServiceControls } from '../src/service-control'
import { createServiceReference, readServiceDefinition } from '@pluxel/core/internal'
import {
	createCoreContextHost,
	getServiceInstallationDefinition,
	installRootService,
} from '@pluxel/core/host'
import {
	loadNativeHostServiceControls,
	readLoadedPluginControl,
} from '../src/control-material.node.ts'
import {
	controlSha256,
	encodeControlData,
	renderPluginDescriptors,
	type ServiceControlManifestEntry,
} from '../src/control-manifest'
import type { HostApplicationFactory } from '../src'

@Plugin()
class Published extends BasePlugin {
	count = 1
}

const OwnerService = createServiceReference<{ read(): string }, 'all'>({
	definition: {
		entry: { kind: 'package-root', packageName: 'control-service-owner' },
		exportName: 'Service',
	},
	access: 'all',
})
const ownerServiceInstallation = installRootService(OwnerService, {
	create: () => ({ read: () => 'value' }),
})

async function material(instance: string) {
	const descriptor = {
		format: 2 as const,
		definition: Published.address(),
		contracts: { config: null as null, instance },
	}
	const files = {
		'index.mjs': renderPluginDescriptors([{ exportName: 'Published', descriptor }]),
		'index.d.mts': 'export declare const Published: object;\n',
	}
	const unsigned = {
		format: 3 as const,
		services: [] as const,
		compiler: 'fixture',
		definitions: [
			{
				definition: descriptor.definition,
				contracts: descriptor.contracts,
				exportName: 'Published',
				module: 'index.mjs',
				source: 'fixture',
			},
		],
		files: await Promise.all(
			Object.entries(files).map(async ([path, content]) => ({
				path,
				size: Buffer.byteLength(content),
				sha256: await controlSha256(content),
			})),
		),
	}
	const manifest = {
		...unsigned,
		snapshot: `sha256:${await controlSha256(encodeControlData(unsigned))}`,
	}
	return { ...files, 'manifest.json': `${encodeControlData(manifest)}\n` }
}

async function publish(root: string, instance: string) {
	const files = await material(instance)
	await mkdir(resolve(root, 'control'), { recursive: true })
	for (const [path, content] of Object.entries(files))
		await writeFile(resolve(root, 'control', path), content)
}

async function publishServiceMaterial(
	root: string,
	services: readonly ServiceControlManifestEntry[],
) {
	const files = {
		'index.mjs': renderPluginDescriptors(
			[],
			services.map(({ exportName, definition, contract, access }) => ({
				exportName,
				descriptor: { format: 1, definition, contract, access },
			})),
		),
		'index.d.mts': services
			.map(({ exportName }) => `export declare const ${exportName}: object;\n`)
			.join(''),
	}
	const unsigned = {
		format: 3 as const,
		compiler: 'fixture',
		definitions: [] as const,
		services,
		files: await Promise.all(
			Object.entries(files).map(async ([path, text]) => ({
				path,
				size: Buffer.byteLength(text),
				sha256: await controlSha256(text),
			})),
		),
	}
	const manifest = {
		...unsigned,
		snapshot: `sha256:${await controlSha256(encodeControlData(unsigned))}`,
	}
	await mkdir(resolve(root, 'control'), { recursive: true })
	for (const [path, text] of Object.entries({
		...files,
		'manifest.json': `${encodeControlData(manifest)}\n`,
	}))
		await writeFile(resolve(root, 'control', path), text)
	return manifest
}

it('validates the exact loaded owner and preserves the first constructor control snapshot across file changes', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-control-owner-'))
	try {
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({ name: 'published-control', pluxel: { control: './control/manifest.json' } }),
		)
		const module = resolve(root, 'entry.mjs')
		await writeFile(module, 'export {}\n')
		const first = `sha256:${'1'.repeat(64)}`
		const second = `sha256:${'2'.repeat(64)}`
		await publish(root, first)
		const owner = installedPackageFacts(module)!
		expect(readLoadedPluginControl(owner, Published.address())).toMatchObject({
			state: 'available',
			contracts: { instance: first },
		})
		recordLoadedPluginModule(Published, module, owner)
		await publish(root, second)
		recordLoadedPluginModule(Published, module, installedPackageFacts(module)!)
		expect(readLoadedPluginModule(Published)?.control).toMatchObject({
			state: 'available',
			contracts: { instance: first },
		})
		await writeFile(resolve(root, 'control/index.mjs'), 'throw new Error("must never execute")\n')
		expect(
			readLoadedPluginControl(installedPackageFacts(module)!, Published.address()),
		).toMatchObject({ state: 'unavailable', reason: 'analysis_failed' })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('binds standalone materials to the generated factory module without a package manifest', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-control-standalone-'))
	try {
		const module = resolve(root, 'app.mjs')
		await writeFile(module, 'export {}\n')
		const instance = `sha256:${'3'.repeat(64)}`
		await publish(root, instance)
		const factory: HostApplicationFactory = () => ({ plugins: [{ plugin: Published }] })
		recordLoadedHostApplication(factory, pathToFileURL(module).href, {
			controlManifest: './control/manifest.json',
		})
		recordLoadedApplicationPlugins(factory, [Published])
		expect(readLoadedApplicationControl(factory, Published)).toMatchObject({
			state: 'available',
			contracts: { instance },
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it.each([false, true])(
	'accepts a service sidecar only after its public module exports the installed declaration (match: %s)',
	async (matches) => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-service-owner-'))
		const packageRoot = resolve(root, 'node_modules/control-service-owner')
		const symbol = Symbol.for(`pluxel.control.service-owner.${root}`)
		Reflect.set(globalThis, symbol, OwnerService)
		try {
			await mkdir(resolve(packageRoot, 'control'), { recursive: true })
			await writeFile(
				resolve(packageRoot, 'package.json'),
				JSON.stringify({
					name: 'control-service-owner',
					type: 'module',
					exports: './entry.mjs',
					pluxel: { control: './control/manifest.json' },
				}),
			)
			await writeFile(
				resolve(packageRoot, 'entry.mjs'),
				`export const Service = ${matches ? `globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(symbol))})]` : 'class Unrelated {}'};\n`,
			)
			const contract = `sha256:${'7'.repeat(64)}`
			const definition = readServiceDefinition(OwnerService).definition!
			const manifest = await publishServiceMaterial(packageRoot, [
				{
					definition,
					contract,
					access: 'all',
					exportName: 'Service',
					module: 'index.mjs',
					source: 'fixture',
				},
			])
			const ctx = createCoreContextHost({ services: [ownerServiceInstallation] }).createRoot(
				'native-material',
			)
			await loadNativeHostServiceControls(ctx, root)
			const record = readHostServiceControls(ctx).find((item) => item.target === OwnerService)
			expect(record?.contract).toBe(matches ? contract : undefined)
			expect(record?.material?.snapshot).toBe(matches ? manifest.snapshot : undefined)
		} finally {
			Reflect.deleteProperty(globalThis, symbol)
			await rm(root, { recursive: true, force: true })
		}
	},
)

it.each([
	{ matches: true, foreignFirst: true },
	{ matches: true, foreignFirst: false },
	{ matches: false, foreignFirst: true },
])(
	'uses a reachable installer sidecar for an imported declaration only after proving both native owners ($matches, $foreignFirst)',
	async ({ matches, foreignFirst }) => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-imported-service-owner-'))
		const installations = ['declaration-owner', 'installer-owner'].map((packageName) =>
			installRootService(
				createServiceReference<{ read(): string }, 'all'>({
					definition: { entry: { kind: 'package-root', packageName }, exportName: 'Service' },
					access: 'all',
				}),
				{ create: () => ({ read: () => 'value' }) },
			),
		)
		const services = installations.map(getServiceInstallationDefinition)
		const symbols = services.map((service, index) => {
			const symbol = Symbol.for(`pluxel.control.imported-service.${root}.${index}`)
			Reflect.set(globalThis, symbol, service)
			return symbol
		})
		try {
			for (const [index, packageName] of ['declaration-owner', 'installer-owner'].entries()) {
				const directory = resolve(root, 'node_modules', packageName)
				await mkdir(directory, { recursive: true })
				await writeFile(
					resolve(directory, 'package.json'),
					JSON.stringify({
						name: packageName,
						type: 'module',
						exports: './entry.mjs',
						...(index === 1 ? { pluxel: { control: './control/manifest.json' } } : {}),
					}),
				)
				await writeFile(
					resolve(directory, 'entry.mjs'),
					`export const Service = ${index === 1 || matches ? `globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(symbols[index]!))})]` : 'class Unrelated {}'};\n`,
				)
			}
			const manifest = await publishServiceMaterial(
				resolve(root, 'node_modules/installer-owner'),
				services.map((service, index) => ({
					definition: readServiceDefinition(service).definition!,
					contract: `sha256:${String(index + 1).repeat(64)}`,
					access: 'all',
					exportName: index === 0 ? 'ImportedService' : 'Service',
					module: 'index.mjs',
					source: 'fixture',
				})),
			)
			const ctx = createCoreContextHost({
				services: foreignFirst ? installations : installations.toReversed(),
			}).createRoot('imported-material')
			await loadNativeHostServiceControls(ctx, root)
			const controls = readHostServiceControls(ctx)
			expect(controls.find((item) => item.target === services[0])?.material?.snapshot).toBe(
				matches ? manifest.snapshot : undefined,
			)
			expect(controls.find((item) => item.target === services[1])?.material?.snapshot).toBe(
				manifest.snapshot,
			)
		} finally {
			for (const symbol of symbols) Reflect.deleteProperty(globalThis, symbol)
			await rm(root, { recursive: true, force: true })
		}
	},
)
