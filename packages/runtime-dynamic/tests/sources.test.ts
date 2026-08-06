import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } from '../src/hmr/host.ts'
import {
	DynamicPluginSourceRequirementError,
	requireDynamicPluginSource,
} from '../src/source-producer.ts'
import { resolveDynamicPluginSources } from '../src/sources.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('dynamic plugin sources', () => {
	it('discovers current entries and retains missing directories as watch roots', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-dynamic-sources-'))
		roots.push(root)
		await mkdir(resolve(root, 'managed'), { recursive: true })
		await writeFile(resolve(root, 'managed', 'alpha.mjs'), 'export const alpha = true\n')
		await writeFile(resolve(root, 'managed', 'ignored.json'), '{}\n')

		const resolved = await resolveDynamicPluginSources(root, [
			{ kind: 'directory', path: 'managed', include: ['*.mjs'] },
			{ kind: 'directory', path: 'future', include: ['*.mjs'] },
		])

		expect(resolved.entries).toEqual([resolve(root, 'managed', 'alpha.mjs')])
		expect(resolved.roots).toEqual(
			expect.arrayContaining([resolve(root, 'managed'), resolve(root, 'future')]),
		)
		expect(resolved.includeGlobs).toEqual(
			expect.arrayContaining([resolve(root, 'managed', '*.mjs'), resolve(root, 'future', '*.mjs')]),
		)
	})

	it('exposes stable source requirement errors', () => {
		const context = { root: {} } as never
		expect(() =>
			requireDynamicPluginSource(context, {
				kind: 'directory',
				path: '/tmp/entries',
				include: ['*.mjs'],
			}),
		).toThrowError(
			expect.objectContaining<Partial<DynamicPluginSourceRequirementError>>({
				code: 'DYNAMIC_SOURCE_REQUIRED',
			}),
		)
	})

	it('loads and unloads a plugin added to a previously missing source directory', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-dynamic-source-lifecycle-'))
		roots.push(root)
		await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n')
		await writeFile(
			resolve(root, 'pluxel.loader.hmr.jsonc'),
			JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		)

		const plan = await planLoaderHmrHostFromConfig({
			root,
			chdir: false,
			logging: false,
			printUrls: false,
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
				snapshot: { enabled: ['MutableSourcePlugin'] },
			},
			sources: [{ kind: 'directory', path: 'entries', include: ['*.mjs'] }],
		})
		const host = await bootPlannedLoaderHmrHost(plan)
		try {
			await host.hmr.start()
			const entriesDir = resolve(root, 'entries')
			const entry = resolve(entriesDir, 'mutable.mjs')
			const temporary = resolve(root, 'mutable.mjs.tmp')
			const addedBatch = host.hmr.api.waitForBatch({ timeoutMs: 30_000 })
			await mkdir(entriesDir, { recursive: true })
			await writeFile(
				temporary,
				[
					"import { BasePlugin, Plugin } from '@pluxel/runtime'",
					'export class MutableSourcePlugin extends BasePlugin {',
					'  started = false',
					'  stopped = false',
					'  cleaned = false',
					'  init() {',
					'    this.started = true',
					'    this.ctx.effects.defer(() => { this.cleaned = true })',
					'  }',
					'  stop() { this.stopped = true }',
					'}',
					"Plugin({ name: 'MutableSourcePlugin' })(MutableSourcePlugin)",
					'',
				].join('\n'),
			)
			await rename(temporary, entry)

			const added = await addedBatch
			expect(added.ok).toBe(true)
			expect(added.pluginChanges?.added).toContain('MutableSourcePlugin')
			const ctor = host.ctx.loader.api.registry.getCtor('MutableSourcePlugin')
			expect(ctor).toBeTypeOf('function')
			const instance = host.ctx.registry.getInstance(ctor!) as
				| { started: boolean; stopped: boolean; cleaned: boolean }
				| undefined
			expect(instance).toMatchObject({ started: true, stopped: false, cleaned: false })

			const removedBatch = host.hmr.api.waitForBatch({
				afterEpoch: added.epoch,
				timeoutMs: 30_000,
			})
			await rm(entry)
			const removed = await removedBatch

			expect(removed.ok).toBe(true)
			expect(removed.pluginChanges?.removed).toContain('MutableSourcePlugin')
			expect(host.ctx.loader.api.registry.getCtor('MutableSourcePlugin')).toBeUndefined()
			expect(host.ctx.registry.isRunning(ctor!)).toBe(false)
			expect(instance).toMatchObject({ started: true, stopped: true, cleaned: true })
		} finally {
			await host.stop()
		}
	}, 60_000)

	it('starts fixed source producers only after their source watcher is installed', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-dynamic-source-producer-'))
		roots.push(root)
		await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n')
		await writeFile(
			resolve(root, 'pluxel.loader.hmr.jsonc'),
			JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		)

		class SourceProducerPlugin extends BasePlugin {
			override async init(): Promise<void> {
				const entriesDir = resolve(root, 'entries')
				requireDynamicPluginSource(this.ctx, {
					kind: 'directory',
					path: entriesDir,
					include: ['*.mjs'],
				})
				const temporary = resolve(root, 'published.mjs.tmp')
				await mkdir(entriesDir, { recursive: true })
				await writeFile(
					temporary,
					[
						"import { BasePlugin, Plugin } from '@pluxel/runtime'",
						'export class PublishedByFixedPlugin extends BasePlugin {}',
						"Plugin({ name: 'PublishedByFixedPlugin' })(PublishedByFixedPlugin)",
						'',
					].join('\n'),
				)
				await rename(temporary, resolve(entriesDir, 'published.mjs'))
			}
		}
		Plugin({ name: 'SourceProducerPlugin' })(SourceProducerPlugin)

		const plan = await planLoaderHmrHostFromConfig({
			root,
			chdir: false,
			logging: false,
			printUrls: false,
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
				snapshot: { enabled: ['SourceProducerPlugin', 'PublishedByFixedPlugin'] },
			},
			plugins: [SourceProducerPlugin],
			sources: [{ kind: 'directory', path: 'entries', include: ['*.mjs'] }],
		})
		const host = await bootPlannedLoaderHmrHost(plan)
		try {
			expect(host.ctx.registry.isRunning(SourceProducerPlugin)).toBe(false)
			const publishedBatch = host.hmr.api.waitForBatch({ timeoutMs: 30_000 })

			await host.hmr.start()
			const published = await publishedBatch

			expect(host.ctx.registry.isRunning(SourceProducerPlugin)).toBe(true)
			expect(published.ok).toBe(true)
			expect(published.pluginChanges?.added).toContain('PublishedByFixedPlugin')
		} finally {
			await host.stop()
		}
	}, 60_000)
})
