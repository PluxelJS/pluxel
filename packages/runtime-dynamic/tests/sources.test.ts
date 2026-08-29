import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { formatPluginNodeReference, pluginNodeAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import { requireLoaderService } from '../src/context-plan.ts'
import { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } from '../src/hmr/host.ts'
import {
	DynamicPluginSourceRequirementError,
	requireDynamicPluginSource,
} from '../src/source-producer.ts'
import { resolveDynamicPluginSources } from '../src/sources.ts'
import { lowerTestPlugin } from './support/lowered-plugin'

function expectSuccessfulBatch(batch: { readonly ok: boolean }): void {
	if (!batch.ok)
		throw new Error(`Expected successful HMR batch:\n${JSON.stringify(batch, null, 2)}`)
}

describe('dynamic plugin sources', () => {
	it('discovers current entries and retains missing directories as watch roots', async () => {
		await using fixture = await createDiskFixture({
			'managed/alpha.mjs': 'export const alpha = true\n',
			'managed/ignored.json': '{}\n',
		})
		const root = fixture.path

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
		await using fixture = await createDiskFixture({
			'pnpm-workspace.yaml': 'packages: []\n',
			'pluxel.loader.hmr.jsonc': JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		})
		const root = fixture.path
		const plan = await planLoaderHmrHostFromConfig({
			root,
			chdir: false,
			logging: false,
			printUrls: false,
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
			},
			sources: [{ kind: 'directory', path: 'entries', include: ['*.ts'] }],
		})
		const host = await bootPlannedLoaderHmrHost(plan)
		try {
			await host.hmr.start()
			const entriesDir = resolve(root, 'entries')
			const entry = resolve(entriesDir, 'mutable.ts')
			const temporary = resolve(root, 'mutable.ts.tmp')
			const addedBatch = host.hmr.api.waitForBatch({ timeoutMs: 30_000 })
			await mkdir(entriesDir, { recursive: true })
			await writeFile(
				temporary,
				[
					"import { BasePlugin, Plugin, PluginPart } from '@pluxel/runtime'",
					'class MutableSourcePart extends PluginPart<MutableSourcePlugin> {',
					'  started = false',
					'  cleaned = false',
					'  protected override init() {',
					'    this.started = true',
					'    this.ctx.effects.defer(() => { this.cleaned = true })',
					'  }',
					'  snapshot() { return { started: this.started, cleaned: this.cleaned } }',
					'}',
					"@Plugin({ displayName: 'Mutable source' })",
					'export class MutableSourcePlugin extends BasePlugin {',
					'  private readonly part = this.parts.use(MutableSourcePart)',
					'  started = false',
					'  cleaned = false',
					'  protected override init() {',
					'    this.started = true',
					'    this.ctx.effects.defer(() => { this.cleaned = true })',
					'  }',
					'  partSnapshot() { return this.part.snapshot() }',
					'}',
					'',
				].join('\n'),
			)
			await rename(temporary, entry)

			const added = await addedBatch
			expectSuccessfulBatch(added)
			const catalogEntry = requireLoaderService(host.ctx)
				.api.registry.listRegistered()
				.find((candidate) => candidate.rootExportName === 'MutableSourcePlugin')
			expect(catalogEntry).toBeDefined()
			const mutableAddress = catalogEntry!.address
			const ctor = catalogEntry!.ctor
			expect(ctor).toBeTypeOf('function')
			await requireLoaderService(host.ctx).api.control.start(mutableAddress)
			const instance = requirePluginService(host.ctx).getInstance(mutableAddress) as
				| {
						started: boolean
						cleaned: boolean
						partSnapshot(): { started: boolean; cleaned: boolean }
				  }
				| undefined
			expect(instance).toMatchObject({ started: true, cleaned: false })
			expect(instance?.partSnapshot()).toEqual({ started: true, cleaned: false })

			const removedBatch = host.hmr.api.waitForBatch({
				afterEpoch: added.epoch,
				timeoutMs: 30_000,
			})
			await rm(entry)
			const removed = await removedBatch

			expect(removed.ok).toBe(true)
			expect(removed.pluginChanges?.removed).toContain(formatPluginNodeReference(mutableAddress))
			expect(requireLoaderService(host.ctx).api.registry.getCtor(mutableAddress)).toBeUndefined()
			expect(requirePluginService(host.ctx).isRunning(mutableAddress)).toBe(false)
			expect(instance).toMatchObject({ started: true, cleaned: true })
			expect(instance?.partSnapshot()).toEqual({ started: true, cleaned: true })
		} finally {
			await host.stop()
		}
	}, 60_000)

	it('starts fixed source producers only after their source watcher is installed', async () => {
		await using fixture = await createDiskFixture({
			'pnpm-workspace.yaml': 'packages: []\n',
			'pluxel.loader.hmr.jsonc': JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		})
		const root = fixture.path

		@Plugin({ displayName: 'Source producer' })
		class SourceProducerPlugin extends BasePlugin {
			override async init(): Promise<void> {
				const entriesDir = resolve(root, 'entries')
				requireDynamicPluginSource(this.ctx, {
					kind: 'directory',
					path: entriesDir,
					include: ['*.ts'],
				})
				const temporary = resolve(root, 'published.ts.tmp')
				await mkdir(entriesDir, { recursive: true })
				await writeFile(
					temporary,
					[
						"import { BasePlugin, Plugin } from '@pluxel/runtime'",
						"@Plugin({ displayName: 'Published by fixed' })",
						'export class PublishedByFixedPlugin extends BasePlugin {}',
						'',
					].join('\n'),
				)
				await rename(temporary, resolve(entriesDir, 'published.ts'))
			}
		}
		lowerTestPlugin(SourceProducerPlugin)

		const plan = await planLoaderHmrHostFromConfig({
			root,
			chdir: false,
			logging: false,
			printUrls: false,
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
				snapshot: { autoStart: [pluginNodeAddressOf(SourceProducerPlugin)] },
			},
			plugins: [SourceProducerPlugin],
			sources: [{ kind: 'directory', path: 'entries', include: ['*.ts'] }],
		})
		const host = await bootPlannedLoaderHmrHost(plan)
		try {
			expect(
				requirePluginService(host.ctx).isRunning(pluginNodeAddressOf(SourceProducerPlugin)),
			).toBe(false)
			const publishedBatch = host.hmr.api.waitForBatch({ timeoutMs: 30_000 })

			await host.hmr.start()
			const published = await publishedBatch

			expect(
				requirePluginService(host.ctx).isRunning(pluginNodeAddressOf(SourceProducerPlugin)),
			).toBe(true)
			expectSuccessfulBatch(published)
			expect(
				requireLoaderService(host.ctx)
					.api.registry.listRegistered()
					.some((entry) => entry.rootExportName === 'PublishedByFixedPlugin'),
			).toBe(true)
		} finally {
			await host.stop()
		}
	}, 60_000)
})
