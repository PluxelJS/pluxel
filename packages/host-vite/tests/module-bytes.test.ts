import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'
import { createServer } from 'vite'
import {
	collectHostEvaluatedInputs,
	collectHostImportFiles,
	hostEnvironment,
	importHostModule,
	invalidateHostModule,
	invalidateHostModuleGraphFiles,
	HOST_VITE_ENVIRONMENT,
} from '../src/environment'
import { createHostModuleBytes } from '../src/module-bytes'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { hostSingletons } from '../src/singletons'

it('tracks the original Plugin bytes and dependency bytes across Vite cache replacement', async () => {
	const pluginSource = `
import { BasePlugin, Plugin } from '@pluxel/core'
import { offset } from './dependency.ts'
@Plugin()
export class Owner extends BasePlugin { value = offset }
export const value = offset
`
	const dependencySource = 'export const offset: number = 1\n'
	await using fixture = await createDiskFixture({
		'package.json': JSON.stringify({ type: 'module' }),
		'entry.ts': pluginSource,
		'dependency.ts': dependencySource,
		'unloaded.ts': dependencySource,
	})
	await mkdir(resolve(fixture.path, 'node_modules/@pluxel'), { recursive: true })
	await symlink(
		resolve(import.meta.dirname, '../../core'),
		resolve(fixture.path, 'node_modules/@pluxel/core'),
		'dir',
	)
	const entry = fixture.getPath('entry.ts')
	const dependency = fixture.getPath('dependency.ts')
	const unloaded = fixture.getPath('unloaded.ts')
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
		expect(await bytes.unchanged(entry)).toBe(false)
		expect(await importHostModule(server, entry)).toMatchObject({ value: 1 })
		const files = collectHostImportFiles(server, entry)
		expect(files).toEqual(new Set([entry, dependency]))
		const accepted = bytes.snapshot([...files, unloaded])
		expect(new Set(accepted.keys())).toEqual(files)
		for (const file of files) expect(await bytes.unchanged(file, accepted)).toBe(true)
		expect(await bytes.unchanged(unloaded)).toBe(false)

		await writeFile(dependency, 'export const offset: number = 2\n')
		expect(await bytes.unchanged(dependency)).toBe(false)
		expect(await importHostModule(server, entry)).toMatchObject({ value: 1 })
		const evaluated = collectHostEvaluatedInputs(server, entry)
		expect(evaluated.get(entry)).toBe(pluginSource)
		expect(evaluated.get(dependency)).toBe(dependencySource)

		invalidateHostModuleGraphFiles(server, files)
		for (const file of files) invalidateHostModule(server, file)
		expect(await importHostModule(server, entry)).toMatchObject({ value: 2 })
		expect(await bytes.unchanged(dependency)).toBe(true)
		expect(await bytes.unchanged(dependency, accepted)).toBe(false)
		await rm(dependency)
		expect(await bytes.unchanged(dependency)).toBe(false)
		await mkdir(dependency)
		await expect(bytes.unchanged(dependency)).rejects.toMatchObject({ code: 'EISDIR' })
	} finally {
		await server.close()
	}
})
