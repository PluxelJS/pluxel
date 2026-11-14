import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pluginDefinitionIndexKey, type PluginConstructor } from '@pluxel/core'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { emptyHostPluginControls, prepareHostPluginControls } from '../src/control'
import { hostEnvironment, HOST_VITE_ENVIRONMENT, importHostModule } from '../src/environment'
import { invalidateHostChangedModules } from '../src/invalidation'
import { hostSingletons } from '../src/singletons'

it.each(['application import', 'independent source'])(
	'binds %s controls to evaluated inputs and replaces the definition for a type-only change',
	async (loading) => {
		const directory = await mkdtemp(resolve(import.meta.dirname, '.control-'))
		await mkdir(resolve(directory, 'node_modules'))
		await symlink(
			await realpath(resolve(import.meta.dirname, '../../rolldown/node_modules/valibot')),
			resolve(directory, 'node_modules/valibot'),
			'dir',
		)
		const entry = resolve(directory, 'entry.ts'),
			owner = resolve(directory, 'owner.ts'),
			payload = resolve(directory, 'payload.ts'),
			sibling = resolve(directory, 'sibling.ts')
		await writeFile(
			resolve(directory, 'tsconfig.json'),
			JSON.stringify({
				extends: resolve(import.meta.dirname, '../tsconfig.json'),
				include: ['*.ts'],
				compilerOptions: { experimentalDecorators: true },
			}),
		)
		await writeFile(payload, 'export interface Payload { id:string }\n')
		const original =
			"import {BasePlugin,Plugin} from '@pluxel/core'; import * as v from 'valibot'; import type {Payload} from './payload.ts'; @Plugin() export class Owner extends BasePlugin { private readonly config=this.configs.use(v.object({count:v.optional(v.number(),2)})); value(input:Payload):Payload{return input} count(){return this.config.count} }\n"
		await writeFile(owner, original)
		await writeFile(
			sibling,
			"import {BasePlugin,Plugin} from '@pluxel/core'; import * as v from 'valibot'; @Plugin() export class Sibling extends BasePlugin { private readonly config=this.configs.use(v.object({enabled:v.optional(v.boolean(),true)})); value(value:string):string{return value} }\n",
		)
		await writeFile(
			entry,
			loading === 'application import'
				? "export {Owner} from './owner.ts'; export {Sibling} from './sibling.ts'\n"
				: 'export const application = true\n',
		)
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
			await importHostModule(server, entry)
			const first = await importHostModule<{ Owner: PluginConstructor }>(server, owner)
			const firstSibling = await importHostModule<{ Sibling: PluginConstructor }>(server, sibling)
			const key = pluginDefinitionIndexKey(first.Owner.definitionAddress())
			const siblingKey = pluginDefinitionIndexKey(firstSibling.Sibling.definitionAddress())
			const prepared = await prepareHostPluginControls({
				server,
				entry,
				plugins: [first.Owner, firstSibling.Sibling],
				semantics: pipeline.semantics,
				previous: emptyHostPluginControls(),
			})
			expect(prepared.metadata.get(key)).toMatchObject({
				state: 'available',
			})
			const siblingBefore = prepared.metadata.get(siblingKey)
			if (siblingBefore?.state !== 'available')
				throw new Error('Expected available sibling contracts')
			expect(prepared.owners.get(payload)).toEqual(new Set([owner]))
			expect(prepared.owners.get(owner)).toEqual(new Set([owner]))
			await writeFile(payload, 'export interface Payload { id:number }\n')
			const cached = await prepareHostPluginControls({
				server,
				entry,
				plugins: [first.Owner, firstSibling.Sibling],
				semantics: pipeline.semantics,
				previous: prepared,
			})
			expect(cached.metadata.get(key)).toMatchObject({
				state: 'unavailable',
				reason: 'source_changed',
			})
			invalidateHostChangedModules({
				server,
				changes: [...prepared.owners.get(payload)!].map((file) => ({
					file,
					reloadDependencies: false,
				})),
				applicationFiles: new Set([entry, owner]),
				recoverMissingImports: false,
			})
			await importHostModule(server, entry)
			const second = await importHostModule<{ Owner: PluginConstructor }>(server, owner)
			const secondSibling = await importHostModule<{ Sibling: PluginConstructor }>(server, sibling)
			expect(second.Owner).not.toBe(first.Owner)
			expect(secondSibling.Sibling).toBe(firstSibling.Sibling)
			const replaced = await prepareHostPluginControls({
				server,
				entry,
				plugins: [second.Owner, secondSibling.Sibling],
				semantics: pipeline.semantics,
				previous: prepared,
			})
			expect(replaced.metadata.get(key)).toMatchObject({ state: 'available' })
			const before = prepared.metadata.get(key)!,
				after = replaced.metadata.get(key)!
			if (before.state !== 'available' || after.state !== 'available')
				throw new Error('Expected available contracts')
			expect(before.contracts.config).toMatch(/^sha256:/)
			expect(before.material?.files['index.d.mts']).toContain('v.optional(v.number(),2)')
			expect(after.contracts.instance).not.toBe(before.contracts.instance)
			expect(after.contracts.config).toBe(before.contracts.config)
			expect(replaced.metadata.get(siblingKey)).toMatchObject({
				state: 'available',
				contracts: siblingBefore.contracts,
			})
			await writeFile(owner, original.replace('return input', 'throw new Error("disk differs")'))
			const stale = await prepareHostPluginControls({
				server,
				entry,
				plugins: [second.Owner, secondSibling.Sibling],
				semantics: pipeline.semantics,
				previous: replaced,
			})
			expect(stale.metadata.get(key)).toMatchObject({
				state: 'unavailable',
				reason: 'source_changed',
			})
		} finally {
			await server.close()
			await rm(directory, { recursive: true, force: true })
		}
	},
	30_000,
)
