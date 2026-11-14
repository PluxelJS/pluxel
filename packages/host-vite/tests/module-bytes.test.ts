import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'
import { createServer } from 'vite'
import {
	hostEnvironment,
	importHostModule,
	invalidateHostModule,
	invalidateHostModuleGraphFiles,
	collectHostImportFiles,
	HOST_VITE_ENVIRONMENT,
} from '../src/environment'
import { createHostModuleBytes } from '../src/module-bytes'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { hostSingletons } from '../src/singletons'

it('records author TypeScript and its runtime dependencies before semantic Plugin lowering', async () => {
	await using fixture = await createDiskFixture({
		'package.json': JSON.stringify({ type: 'module' }),
		'entry.ts':
			"import {BasePlugin,Plugin} from '@pluxel/core'; import {offset} from './dependency.ts'; @Plugin() export class Owner extends BasePlugin { value=offset }",
		'dependency.ts': 'export const offset=1',
	})
	await mkdir(resolve(fixture.path, 'node_modules/@pluxel'), { recursive: true })
	await symlink(
		resolve(import.meta.dirname, '../../core'),
		resolve(fixture.path, 'node_modules/@pluxel/core'),
		'dir',
	)
	const entry = resolve(fixture.path, 'entry.ts')
	const bytes = createHostModuleBytes()
	const pipeline = createPluginSourceVitePipeline({
		root: fixture.path,
		environment: HOST_VITE_ENVIRONMENT,
		lintGuard: false,
	})
	const server = await createServer({
		root: fixture.path,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true, watch: null },
		plugins: [hostEnvironment(), hostSingletons(), bytes.plugin, ...pipeline.plugins],
	})
	try {
		await importHostModule(server, entry)
		const files = collectHostImportFiles(server, entry)
		expect(files).toEqual(new Set([entry, resolve(fixture.path, 'dependency.ts')]))
		const accepted = bytes.snapshot(files)
		expect([...accepted.keys()].sort()).toEqual([...files].sort())
		for (const file of files) expect(await bytes.unchanged(file, accepted)).toBe(true)
	} finally {
		await server.close()
	}
})

it('recognizes only the bytes actually loaded by the Vite runner', async () => {
	await using fixture = await createDiskFixture({
		'package.json': JSON.stringify({ type: 'module' }),
		'loaded.mjs': 'export const value = 1',
		'unloaded.mjs': 'export const value = 1',
	})
	const loaded = resolve(fixture.path, 'loaded.mjs')
	const unloaded = resolve(fixture.path, 'unloaded.mjs')
	const bytes = createHostModuleBytes()
	const server = await createServer({
		root: fixture.path,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true, watch: null },
		plugins: [hostEnvironment(), bytes.plugin],
	})
	try {
		expect(await bytes.unchanged(loaded)).toBe(false)
		expect(await importHostModule(server, loaded)).toMatchObject({ value: 1 })
		expect(await bytes.unchanged(loaded)).toBe(true)
		expect(await bytes.unchanged(unloaded)).toBe(false)
		const accepted = bytes.snapshot([loaded, unloaded])
		expect(await bytes.unchanged(loaded, accepted)).toBe(true)
		await writeFile(loaded, 'export const value = 2')
		expect(await bytes.unchanged(loaded)).toBe(false)
		expect(await importHostModule(server, loaded)).toMatchObject({ value: 1 })
		invalidateHostModuleGraphFiles(server, [loaded])
		invalidateHostModule(server, loaded)
		expect(await importHostModule(server, loaded)).toMatchObject({ value: 2 })
		expect(await bytes.unchanged(loaded)).toBe(true)
		expect(await bytes.unchanged(loaded, accepted)).toBe(false)
		await rm(loaded)
		expect(await bytes.unchanged(loaded)).toBe(false)
		await mkdir(loaded)
		await expect(bytes.unchanged(loaded)).rejects.toMatchObject({ code: 'EISDIR' })
	} finally {
		await server.close()
	}
})
