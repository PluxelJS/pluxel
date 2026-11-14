import { expect, it } from 'vitest'
import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '../src'
import { setHostCatalogProvenance } from '../src/internal'
import {
	controlSha256,
	createPluginControlMaterialReader,
	encodeControlData,
	parsePluginControlFileChunk,
	parsePluginControlManifestIndex,
	renderPluginDescriptors,
	PLUGIN_CONTROL_CACHE_MS,
	readPluginControlMaterials,
	type PluginControlDescriptorData,
	type PluginControlManifest,
	type PluginControlMaterialsSnapshot,
} from '../src/agent'

async function snapshot(
	large = false,
	target?: PluginControlDescriptorData['definition'],
): Promise<PluginControlMaterialsSnapshot> {
	const definition = target ?? {
		entry: { kind: 'package-root' as const, packageName: '@test/materials' },
		exportName: 'Counter',
	}
	const contracts: PluginControlDescriptorData['contracts'] = {
		config: null,
		instance: `sha256:${'b'.repeat(64)}`,
	}
	const files: Record<string, string> = {
		'index.mjs': renderPluginDescriptors([
			{ exportName: 'Counter', descriptor: { format: 1, definition, contracts } },
		]),
		'index.d.mts': `export declare const Counter: object;\n${large ? `/* ${'🧩中'.repeat(30_000)} */` : ''}`,
	}
	if (large)
		for (let index = 0; index < 1000; index++)
			files[`types/${index}_${'x'.repeat(100)}.d.mts`] = 'export {};\n'
	const entries = await Promise.all(
		Object.entries(files).map(async ([path, content]) => ({
			path,
			size: Buffer.byteLength(content),
			sha256: await controlSha256(content),
		})),
	)
	const unsigned = {
		format: 1 as const,
		compiler: 'material-reader-test',
		definitions: [{ definition, exportName: 'Counter', contracts, source: 'index.d.mts' }],
		files: entries,
	}
	const manifest: PluginControlManifest = {
		...unsigned,
		snapshot: `sha256:${await controlSha256(encodeControlData(unsigned))}`,
	}
	files['manifest.json'] = `${encodeControlData(manifest)}\n`
	return {
		catalogRevision: 7,
		materials: [{ snapshot: manifest.snapshot, manifest, files }],
		definitions: [{ definition, snapshot: manifest.snapshot, exportName: 'Counter' }],
		unavailable: [],
	}
}

@Plugin()
class MaterialPlugin extends BasePlugin {}

it('reads the committed candidate material and ignores uncommitted route provenance changes', async () => {
	const source = await snapshot(false, MaterialPlugin.definitionAddress())
	const material = source.materials[0]
	const contracts = material.manifest.definitions[0].contracts
	await using host = await createHost({
		plugins: [MaterialPlugin],
		runtime: { documents: { config: false, state: false } },
	})
	setHostCatalogProvenance(
		host.ctx,
		new Map([
			[MaterialPlugin, { control: { state: 'available', format: 1, contracts, material } }],
		]),
	)
	await host.start()
	expect(await readPluginControlMaterials(host.ctx)).toMatchObject({
		materials: [{ snapshot: material.snapshot }],
		unavailable: [],
	})
	setHostCatalogProvenance(
		host.ctx,
		new Map([[MaterialPlugin, { control: { state: 'unavailable', reason: 'source_changed' } }]]),
	)
	const committed = await readPluginControlMaterials(host.ctx)
	expect(committed.materials).toHaveLength(1)
	await host.updateCatalog([MaterialPlugin])
	expect(await readPluginControlMaterials(host.ctx)).toMatchObject({
		materials: [],
		definitions: [],
		unavailable: [MaterialPlugin.definitionAddress()],
	})
	setHostCatalogProvenance(
		host.ctx,
		new Map([
			[
				MaterialPlugin,
				{
					control: {
						state: 'available',
						format: 1,
						contracts: { ...contracts, instance: `sha256:${'c'.repeat(64)}` },
						material,
					},
				},
			],
		]),
	)
	await host.updateCatalog([MaterialPlugin])
	await expect(readPluginControlMaterials(host.ctx)).rejects.toMatchObject({
		code: 'control_contract_mismatch',
	})
	await expect(
		readPluginControlMaterials(host.ctx, {
			signal: AbortSignal.abort(new Error('Material read cancelled')),
		}),
	).rejects.toThrow('Material read cancelled')
})

it('chunks both a large manifest and UTF-8 declaration files below the existing session DTO budget', async () => {
	const source = await snapshot(true)
	using reader = createPluginControlMaterialReader(async () => source)
	const index = parsePluginControlManifestIndex(await reader.manifest())
	expect(Buffer.byteLength(source.materials[0].files['manifest.json'])).toBeGreaterThan(128 * 1024)
	expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(128 * 1024)
	for (const path of ['manifest.json', 'index.d.mts']) {
		const chunks: Buffer[] = []
		let offset = 0
		for (;;) {
			const chunk = parsePluginControlFileChunk(
				reader.file({ snapshot: index.materials[0].snapshot, path, offset }),
			)
			expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(128 * 1024)
			chunks.push(Buffer.from(chunk.data, 'base64'))
			offset = chunk.nextOffset
			if (chunk.done) break
		}
		expect(Buffer.concat(chunks).toString('utf8')).toBe(source.materials[0].files[path])
	}
})

it('binds file access to one admitted session snapshot, manifest paths, expiry and authorization', async () => {
	const source = await snapshot()
	let now = 10
	const authority = new AbortController()
	using reader = createPluginControlMaterialReader(async () => source, {
		now: () => now,
		signal: authority.signal,
	})
	using other = createPluginControlMaterialReader(async () => source)
	const index = await reader.manifest()
	const file = { snapshot: index.materials[0].snapshot, path: 'index.mjs', offset: 0 }
	expect(() => other.file(file)).toThrow(
		expect.objectContaining({ code: 'control_snapshot_expired' }),
	)
	expect(() => reader.file({ ...file, path: '../index.mjs' })).toThrow(
		expect.objectContaining({ code: 'invalid_request' }),
	)
	expect(() => reader.file({ ...file, path: 'author-private.ts' })).toThrow(
		expect.objectContaining({ code: 'control_file_unavailable' }),
	)
	expect(() => reader.file({ ...file, offset: Number.MAX_SAFE_INTEGER })).toThrow(
		expect.objectContaining({ code: 'invalid_request' }),
	)
	now += PLUGIN_CONTROL_CACHE_MS
	expect(() => reader.file(file)).toThrow(
		expect.objectContaining({ code: 'control_snapshot_expired' }),
	)
	await reader.manifest()
	authority.abort(new Error('authorization withdrawn'))
	expect(() => reader.file(file)).toThrow('authorization withdrawn')
	await expect(reader.manifest()).rejects.toThrow('authorization withdrawn')
})

it('pages committed selections without mixing a new transfer and rejects malformed chunk progress', async () => {
	const source = await snapshot()
	const definitions = Array.from({ length: 20 }, (_, index) => ({
		...source.definitions[0],
		definition: { ...source.definitions[0].definition, exportName: `Counter${index}` },
	}))
	using reader = createPluginControlMaterialReader(async () => ({ ...source, definitions }))
	const first = await reader.manifest()
	expect(first.definitions).toHaveLength(16)
	const second = await reader.manifest({ transfer: first.transfer, offset: first.nextOffset })
	expect(second.definitions).toHaveLength(4)
	expect(second.nextOffset).toBeNull()
	const fresh = await reader.manifest()
	expect(fresh.transfer).not.toBe(first.transfer)
	await expect(reader.manifest({ transfer: first.transfer, offset: 16 })).rejects.toMatchObject({
		code: 'control_snapshot_expired',
	})
	const chunk = reader.file({ snapshot: first.materials[0].snapshot, path: 'index.mjs', offset: 0 })
	expect(() => parsePluginControlFileChunk({ ...chunk, nextOffset: chunk.nextOffset + 1 })).toThrow(
		expect.objectContaining({ code: 'protocol_mismatch' }),
	)
	expect(() =>
		parsePluginControlFileChunk({ ...chunk, done: false, data: '', nextOffset: 0 }),
	).toThrow(expect.objectContaining({ code: 'protocol_mismatch' }))
})
