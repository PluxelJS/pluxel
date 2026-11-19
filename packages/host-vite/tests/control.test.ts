import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pluginDefinitionIndexKey, type PluginConstructor } from '@pluxel/core'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { emptyHostPluginControls, prepareHostPluginControls } from '../src/control'
import {
	collectHostImportFiles,
	hostEnvironment,
	HOST_VITE_ENVIRONMENT,
	importHostModule,
} from '../src/environment'
import { invalidateHostChangedModules } from '../src/invalidation'
import { hostSingletons } from '../src/singletons'

it('binds app imports and independent Plugin sources to the evaluated definitions', async () => {
	const original = `
import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import type { Payload } from './payload.ts'
@Plugin()
export class Owner extends BasePlugin {
	private readonly config = this.configs.use(v.object({ count: v.optional(v.number(), 2) }))
	value(input: Payload): Payload { return input }
	count() { return this.config.count }
}
`
	await using fixture = await createDiskFixture({
		'package.json': JSON.stringify({ name: 'control-fixture', type: 'module' }),
		'tsconfig.json': JSON.stringify({
			// An application checks these Plugins against the framework's published declarations.
			compilerOptions: {
				target: 'ES2024',
				module: 'ESNext',
				moduleResolution: 'bundler',
				experimentalDecorators: true,
				strict: true,
				types: ['node'],
			},
		}),
		'entry.ts': "export { Sibling } from './sibling.ts'\n",
		'owner.ts': original,
		'payload.ts': 'export interface Payload { id: string }\n',
		'sibling.ts': `
import { BasePlugin, Plugin } from '@pluxel/core'
@Plugin()
export class Sibling extends BasePlugin {
	value(input: string): string { return input }
}
`,
	})
	const directory = fixture.path
	for (const [name, from] of [
		['@pluxel/core', '../../core'],
		['@types/node', '../../../node_modules/@types/node'],
		['valibot', '../../rolldown/node_modules/valibot'],
	]) {
		const target = resolve(directory, 'node_modules', name)
		await mkdir(dirname(target), { recursive: true })
		await symlink(resolve(import.meta.dirname, from), target, 'dir')
	}
	const entry = fixture.getPath('entry.ts')
	const owner = fixture.getPath('owner.ts')
	const payload = fixture.getPath('payload.ts')
	const pipeline = createPluginSourceVitePipeline({
		root: directory,
		environment: HOST_VITE_ENVIRONMENT,
		lintGuard: false,
	})
	const server = await createServer({
		root: directory,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true, watch: null },
		plugins: [hostEnvironment(), hostSingletons(), ...pipeline.plugins],
	})
	try {
		const { Sibling } = await importHostModule<{ Sibling: PluginConstructor }>(server, entry)
		const first = await importHostModule<{ Owner: PluginConstructor }>(server, owner)
		const key = pluginDefinitionIndexKey(first.Owner.address())
		const siblingKey = pluginDefinitionIndexKey(Sibling.address())
		const prepare = (Owner: PluginConstructor, previous = emptyHostPluginControls()) =>
			prepareHostPluginControls({
				server,
				entry,
				plugins: [Owner, Sibling],
				semantics: pipeline.semantics,
				previous,
			})
		const prepared = await prepare(first.Owner)
		const before = prepared.metadata.get(key)
		const siblingBefore = prepared.metadata.get(siblingKey)
		assert(
			before?.state === 'available',
			before?.state === 'unavailable' ? before.message : 'Missing owner controls',
		)
		assert(
			siblingBefore?.state === 'available',
			siblingBefore?.state === 'unavailable' ? siblingBefore.message : 'Missing sibling controls',
		)
		expect(prepared.owners.get(payload)).toEqual(new Set([owner]))
		expect(prepared.owners.get(owner)).toEqual(new Set([owner]))

		await writeFile(payload, 'export interface Payload { id: number }\n')
		const cached = await prepare(first.Owner, prepared)
		expect(cached.metadata.get(key)).toMatchObject({
			state: 'unavailable',
			reason: 'source_changed',
			message: expect.stringContaining('declaration changed without definition replacement'),
		})

		invalidateHostChangedModules({
			server,
			changes: [...prepared.owners.get(payload)!].map((file) => ({
				file,
				reloadDependencies: false,
			})),
			applicationFiles: collectHostImportFiles(server, entry),
			recoverMissingImports: false,
		})
		const second = await importHostModule<{ Owner: PluginConstructor }>(server, owner)
		expect(second.Owner).not.toBe(first.Owner)
		const currentEntry = await importHostModule<{ Sibling: PluginConstructor }>(server, entry)
		expect(currentEntry.Sibling).toBe(Sibling)
		const replaced = await prepare(second.Owner, prepared)
		const after = replaced.metadata.get(key)
		assert(
			after?.state === 'available',
			after?.state === 'unavailable' ? after.message : 'Missing replacement controls',
		)
		expect(after.contracts.instance).not.toBe(before.contracts.instance)
		expect(after.contracts.config).toBe(before.contracts.config)
		expect(replaced.metadata.get(siblingKey)).toMatchObject({
			state: 'available',
			contracts: siblingBefore.contracts,
		})

		await writeFile(owner, original.replace('return input', 'throw new Error("disk differs")'))
		const stale = await prepare(second.Owner, replaced)
		expect(stale.metadata.get(key)).toMatchObject({
			state: 'unavailable',
			reason: 'source_changed',
			message: expect.stringContaining('evaluated Plugin input cannot be matched'),
		})
	} finally {
		await server.close()
	}
}, 30_000)
