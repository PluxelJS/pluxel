import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import {
	encodeControlData,
	parsePluginControlManifest,
	renderPluginDescriptors,
	verifyPluginControlMaterialSync,
	type PluginControlManifest,
	type ServiceControlManifestEntry,
} from '@pluxel/core/internal/control-manifest'
import { createFixture } from 'fs-fixture'
import { expect, it } from 'vitest'
import {
	collectBundledServiceMaterials,
	mergeBundledServiceMaterials,
} from '../src/control/dependencies'
import * as controlContracts from '../src/control/manifest'
import { lowerServiceModule } from '../src/service-semantics'

const packageName = '@example/published-clock'
const packagePath = `node_modules/${packageName}`
const definition: PluginDefinitionAddress = {
	entry: { kind: 'package-root', packageName },
	exportName: 'Clock',
}
type Material = Readonly<{
	manifest: PluginControlManifest
	files: Record<string, string>
}>

const sha256 = (content: string | Uint8Array): string =>
	createHash('sha256').update(content).digest('hex')

function sealMaterial(
	files: Record<string, string>,
	services: readonly ServiceControlManifestEntry[],
): Material {
	const unsigned: Omit<PluginControlManifest, 'snapshot'> = {
		format: 3 as const,
		compiler: 'typescript@published-service-fixture',
		definitions: [],
		services,
		files: Object.entries(files)
			.filter(([path]) => path !== 'manifest.json')
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([path, contents]) => ({
				path,
				size: Buffer.byteLength(contents),
				sha256: sha256(contents),
			})),
	}
	const manifest = parsePluginControlManifest({
		...unsigned,
		snapshot: `sha256:${sha256(encodeControlData(unsigned))}`,
	})
	return { manifest, files: { ...files, 'manifest.json': `${encodeControlData(manifest)}\n` } }
}

function materialFor(
	access: ServiceControlManifestEntry['access'] = 'owner',
	identity = definition,
): Material {
	const instance = `import type { ClockReply } from './types/reply.mjs'
import type { ServiceDefinition } from '@pluxel/core'
export interface ClockInstance { now(): ClockReply }
export declare const Clock: ServiceDefinition<ClockInstance, ${JSON.stringify(access)}>
`
	const contract = `sha256:${sha256(encodeControlData({ access, declaration: instance }))}`
	const services: ServiceControlManifestEntry[] = [
		{
			definition: identity,
			module: 'index.mjs',
			exportName: 'Clock',
			contract,
			access,
			source: 'dist/native.d.mts',
		},
	]
	const material = sealMaterial(
		{
			'index.mjs': renderPluginDescriptors(
				[],
				services.map((service) => ({
					exportName: service.exportName,
					descriptor: { format: 1, definition: identity, access, contract },
				})),
			),
			'index.d.mts': instance,
			'types/reply.d.mts':
				"import type { ClockDetail } from './detail.mjs'\nexport interface ClockReply { value: number; detail: ClockDetail }\n",
			'types/detail.d.mts': 'export interface ClockDetail { label: string }\n',
		},
		services,
	)
	verifyPluginControlMaterialSync(material.manifest, material.files, sha256)
	return material
}

function publishedFiles(material: Material): Record<string, string> {
	const access = material.manifest.services[0]!.access
	return {
		'package.json': JSON.stringify({ name: 'published-service-consumer', type: 'module' }),
		'entry.ts': '',
		[`${packagePath}/package.json`]: JSON.stringify({
			name: packageName,
			type: 'module',
			exports: {
				'.': { types: './dist/index.d.mts', default: './dist/index.mjs' },
				'./alias': { types: './dist/alias.d.mts', default: './dist/alias.mjs' },
			},
			pluxel: { control: './dist/control/manifest.json' },
		}),
		[`${packagePath}/dist/index.mjs`]:
			"throw new Error('NATIVE_IMPLEMENTATION_EXECUTED'); export { n as Clock } from './native.mjs'\n",
		[`${packagePath}/dist/alias.mjs`]:
			"throw new Error('NATIVE_IMPLEMENTATION_EXECUTED'); export { n as PublishedClock } from './native.mjs'\n",
		[`${packagePath}/dist/native.mjs`]:
			"throw new Error('NATIVE_IMPLEMENTATION_EXECUTED'); export class n {}\n",
		[`${packagePath}/dist/index.d.mts`]: "export { PublicClock as Clock } from './public.mjs'\n",
		[`${packagePath}/dist/alias.d.mts`]:
			"export { PublicClock as PublishedClock } from './public.mjs'\n",
		[`${packagePath}/dist/public.d.mts`]:
			"export { NativeClock as PublicClock } from './native.mjs'\n",
		[`${packagePath}/dist/native.d.mts`]: `export declare abstract class NativeClock {
 static readonly access: ${JSON.stringify(access)}
 abstract now(): { value: number; detail: { label: string } }
}
export declare abstract class OtherClock { abstract other(): void }
`,
		...Object.fromEntries(
			Object.entries(material.files).map(([path, contents]) => [
				`${packagePath}/dist/control/${path}`,
				contents,
			]),
		),
	}
}

function lowerPublishedRef(directory: string, alias = false) {
	const source = `${packageName}${alias ? '/alias' : ''}`
	const imported = alias ? 'PublishedClock' : 'Clock'
	return lowerServiceModule({
		id: resolve(directory, 'entry.ts'),
		code: `import { defineServiceRef } from '@pluxel/core'
import type { ${imported} as SelectedClock } from ${JSON.stringify(source)}
const optional = defineServiceRef<SelectedClock>()
`,
		resolve: async (specifier) => specifier,
		controlContracts,
		canonicalSourceEntry: async () => {
			throw new Error('Published service must retain its package identity')
		},
		error: (message) => {
			throw new Error(message)
		},
	})
}

it.each(['all', 'owner', 'root'] as const)(
	'proves published native declaration aliases with %s access without evaluating the implementation',
	async (access) => {
		const material = materialFor(access)
		await using fixture = await createFixture(publishedFiles(material))
		const packageRoot = resolve(fixture.path, packagePath)
		const installed = await readdir(packageRoot, { recursive: true })
		expect(installed).not.toContain('src')
		expect(
			installed.filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !/\.mjs$|\.d\.mts$/.test(path)),
		).toEqual([])
		expect(await readFile(resolve(packageRoot, 'dist/index.mjs'), 'utf8')).toContain(
			"throw new Error('NATIVE_IMPLEMENTATION_EXECUTED')",
		)
		for (const alias of [false, true]) {
			const result = await lowerPublishedRef(fixture.path, alias)
			expect(result.services).toEqual([])
			expect(result.hasDefinitions).toBe(false)
			expect(result.hasRefs).toBe(true)
			expect(result.replacements).toHaveLength(1)
			expect(result.replacements[0]!.text).toBe(
				`__pluxelDefineServiceRef(${JSON.stringify({ format: 1, definition, access })})`,
			)
			expect(result.replacements[0]!.text).not.toContain('contract')
		}
	},
)

it.each(['snapshot', 'integrity', 'provider'] as const)(
	'rejects a published service sidecar with corrupted %s evidence',
	async (corruption) => {
		const material = materialFor()
		await using fixture = await createFixture(publishedFiles(material))
		const control = resolve(fixture.path, packagePath, 'dist/control')
		if (corruption === 'snapshot') {
			await writeFile(
				resolve(control, 'manifest.json'),
				`${encodeControlData({ ...material.manifest, snapshot: `sha256:${'0'.repeat(64)}` })}\n`,
			)
		} else if (corruption === 'integrity') {
			await writeFile(
				resolve(control, 'types/detail.d.mts'),
				material.files['types/detail.d.mts']!.replace('label', 'wrong'),
			)
		} else {
			const tampered = sealMaterial(
				{ ...material.files, 'index.mjs': "throw new Error('SIDECAR_EXECUTED')\n" },
				material.manifest.services,
			)
			await writeFile(resolve(control, 'index.mjs'), tampered.files['index.mjs']!)
			await writeFile(resolve(control, 'manifest.json'), tampered.files['manifest.json']!)
		}
		const diagnostic =
			corruption === 'snapshot'
				? 'Control manifest snapshot mismatch'
				: corruption === 'integrity'
					? 'Control file integrity mismatch: types/detail.d.mts'
					: 'Control entry is not the deterministic provider emitter output: index.mjs'
		await expect(lowerPublishedRef(fixture.path, true)).rejects.toThrow(diagnostic)
		await expect(
			collectBundledServiceMaterials([resolve(fixture.path, packagePath, 'dist/index.mjs')]),
		).rejects.toThrow(diagnostic)
	},
)

it('rejects a native alias that names a different declaration from the verified public service', async () => {
	await using fixture = await createFixture(publishedFiles(materialFor()))
	await writeFile(
		resolve(fixture.path, packagePath, 'dist/alias.d.mts'),
		"export { OtherClock as PublishedClock } from './native.mjs'\n",
	)
	await expect(lowerPublishedRef(fixture.path, true)).rejects.toThrow(
		'requires one verified public service declaration',
	)
})

it('carries each bundled published service contract and its complete declaration closure into the application material', async () => {
	const material = materialFor()
	await using fixture = await createFixture(publishedFiles(material))
	const packageRoot = resolve(fixture.path, packagePath)
	const collected = await collectBundledServiceMaterials([
		'node:crypto',
		'\0virtual:service',
		resolve(packageRoot, 'dist/index.mjs'),
		resolve(packageRoot, 'dist/native.mjs'),
	])
	expect(collected).toHaveLength(1)
	expect(collected[0]!.manifest).toEqual(material.manifest)
	expect(collected[0]!.files).toEqual(material.files)
	const merged = await mergeBundledServiceMaterials(undefined, collected)
	expect(merged).toBeDefined()
	const result = merged!
	expect(verifyPluginControlMaterialSync(result.manifest, result.files, sha256)).toEqual(
		result.manifest,
	)
	expect(result.manifest.services).toEqual(material.manifest.services)
	const prefix = `dependencies/${material.manifest.snapshot.slice(7, 31)}`
	for (const [path, contents] of Object.entries(material.files)) {
		if (!path.endsWith('.d.mts')) continue
		expect(result.files[`${prefix}/${path}`]).toBe(contents)
		expect(result.manifest.files).toContainEqual({
			path: `${prefix}/${path}`,
			size: Buffer.byteLength(contents),
			sha256: sha256(contents),
		})
	}
	expect(result.files['index.d.mts']).toContain(`./${prefix}/index.mjs`)
	expect(result.files['index.mjs']).toBe(material.files['index.mjs'])
	expect(Object.keys(result.files).filter((path) => path.endsWith('.mjs'))).toEqual(['index.mjs'])
	expect(result.definitionInputs[pluginDefinitionIndexKey(definition)]).toEqual(
		collected[0]!.inputs,
	)
	for (const path of collected[0]!.inputs)
		expect(result.inputs[path]).toBe(sha256(await readFile(path, 'utf8')))
})

it('preserves existing application services and dependency contracts when their control export names collide', async () => {
	const material = materialFor('owner')
	const applicationDefinition: PluginDefinitionAddress = {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'clock.ts' },
		exportName: 'Clock',
	}
	const base = materialFor('root', applicationDefinition)
	await using fixture = await createFixture(publishedFiles(material))
	const dependencies = await collectBundledServiceMaterials([
		resolve(fixture.path, packagePath, 'dist/index.mjs'),
	])
	const merged = await mergeBundledServiceMaterials(
		{
			format: 3,
			snapshot: base.manifest.snapshot,
			manifest: base.manifest,
			files: base.files,
			inputs: {},
			definitionInputs: {},
		},
		dependencies,
	)
	expect(merged).toBeDefined()
	const result = merged!
	expect(verifyPluginControlMaterialSync(result.manifest, result.files, sha256)).toEqual(
		result.manifest,
	)
	expect(result.manifest.services).toHaveLength(2)
	expect(result.manifest.services[0]).toEqual(base.manifest.services[0])
	expect(result.manifest.services[1]).toMatchObject({
		...material.manifest.services[0],
		exportName: expect.stringMatching(/^Service_[a-f0-9]{24}$/),
	})
	expect(result.files['index.d.mts']).toContain(base.files['index.d.mts'])
	expect(result.files['index.mjs']).toContain(material.manifest.services[0]!.contract)
	expect(result.files['index.mjs']).toContain(base.manifest.services[0]!.contract)
})
