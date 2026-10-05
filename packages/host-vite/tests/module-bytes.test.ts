import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'
import { createServer } from 'vite'
import {
	hostEnvironment,
	importHostModule,
	invalidateHostModule,
	invalidateHostModuleGraphFiles,
} from '../src/environment'
import { createHostModuleBytes } from '../src/module-bytes'

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
		await writeFile(loaded, 'export const value = 2')
		expect(await bytes.unchanged(loaded)).toBe(false)
		expect(await importHostModule(server, loaded)).toMatchObject({ value: 1 })
		invalidateHostModuleGraphFiles(server, [loaded])
		invalidateHostModule(server, loaded)
		expect(await importHostModule(server, loaded)).toMatchObject({ value: 2 })
		expect(await bytes.unchanged(loaded)).toBe(true)
		await rm(loaded)
		expect(await bytes.unchanged(loaded)).toBe(false)
		await mkdir(loaded)
		await expect(bytes.unchanged(loaded)).rejects.toMatchObject({ code: 'EISDIR' })
	} finally {
		await server.close()
	}
})
