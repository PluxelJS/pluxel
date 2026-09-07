import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
	formatPluginNodeReference,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import {
	readRuntimePluginStatusOverview,
	requireRuntimeHttpService,
} from '@pluxel/runtime/internal'
import { __setPluginDefinition } from '@pluxel/runtime/toolchain'
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
					"    this.ctx.elysia.get('/mutable-source', () => 'mutable-source')",
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
			await expect(
				requireRuntimeHttpService(host.ctx)
					.fetch(new Request('http://local.test/mutable-source'))
					.then((response) => response.text()),
			).resolves.toBe('mutable-source')

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
			expect(
				await requireRuntimeHttpService(host.ctx).fetch(
					new Request('http://local.test/mutable-source'),
				),
			).toMatchObject({ status: 404 })
		} finally {
			await host.stop()
		}
	}, 60_000)

	it('reports a managed external wrapper as package identity with honest entry-only provenance', async () => {
		const packageName = '@fixture/managed-external'
		const exportName = 'ManagedExternalPlugin'
		const runtimeBridgeName = 'pluxel.test.runtime-dynamic.managed-external'
		const wrapper = [
			`export * from ${JSON.stringify(packageName)}`,
			`import * as pluginModule from ${JSON.stringify(packageName)}`,
			'export default pluginModule.default',
			'',
		].join('\n')
		await using fixture = await createDiskFixture({
			'pnpm-workspace.yaml': 'packages: []\n',
			'pluxel.loader.hmr.jsonc': JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
			'.pluxel/managed-plugins/entries/managed.mjs': wrapper,
			'.pluxel/managed-plugins/node_modules/@fixture/managed-external/package.json': JSON.stringify(
				{
					name: packageName,
					type: 'module',
					exports: './dist/index.mjs',
				},
			),
			'.pluxel/managed-plugins/node_modules/@fixture/managed-external/dist/index.mjs': [
				`const fixtureRuntime = globalThis[Symbol.for(${JSON.stringify(runtimeBridgeName)})]`,
				"if (!fixtureRuntime) throw new Error('managed external fixture runtime is unavailable')",
				'const { BasePlugin, Plugin, setPluginDefinition } = fixtureRuntime',
				`class ${exportName} extends BasePlugin {}`,
				`Plugin({ displayName: 'Managed external' })(${exportName})`,
				`setPluginDefinition(${exportName}, {`,
				'  abiVersion: 2,',
				"  kind: 'plugin',",
				`  definition: { entry: { kind: 'package-root', packageName: ${JSON.stringify(packageName)} }, exportName: ${JSON.stringify(exportName)} },`,
				'  constructorRequires: [],',
				'  optional: [],',
				'})',
				`export { ${exportName} }`,
				'',
			].join('\n'),
		})
		const root = fixture.path
		const runtimeBridgeKey = Symbol.for(runtimeBridgeName)
		Reflect.set(globalThis, runtimeBridgeKey, {
			BasePlugin,
			Plugin,
			setPluginDefinition: __setPluginDefinition,
		})

		const plan = await planLoaderHmrHostFromConfig({
			root,
			logging: false,
			printUrls: false,
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			sources: [
				{
					kind: 'directory',
					path: '.pluxel/managed-plugins/entries',
					include: ['*.mjs'],
				},
			],
		})
		const host = await bootPlannedLoaderHmrHost(plan)
		try {
			await host.hmr.start()
			const catalogEntry = requireLoaderService(host.ctx)
				.api.registry.listRegistered()
				.find((candidate) => candidate.rootExportName === exportName)
			expect(catalogEntry).toBeDefined()
			const address = catalogEntry!.address
			expect(address.definition).toEqual({
				entry: { kind: 'package-root', packageName },
				exportName,
			})
			expect(formatPluginNodeReference(address)).toBe(`package:${packageName}::${exportName}`)

			const statusOverview = await readRuntimePluginStatusOverview(host.ctx)
			const status = statusOverview.statuses.find((candidate) =>
				pluginNodeAddressEqual(candidate.address, address),
			)
			expect(status).toBeDefined()
			expect(status).toMatchObject({
				recentUpdate: null,
				execution: {
					kind: 'dynamic-entry',
					artifact: { kind: 'unreported' },
					update: { kind: 'definition-hmr', scope: 'entry-only' },
				},
			})
			expect(JSON.stringify(status)).not.toContain(root)
			expect(host.hmr.api.lastBatch()).toBeNull()

			const packageModulePath = resolve(
				root,
				'.pluxel/managed-plugins/node_modules/@fixture/managed-external/dist/index.mjs',
			)
			const unexpectedPackageBatch = host.hmr.api.waitForBatch({ timeoutMs: 500 }).then(
				() => null,
				(error: unknown) => error,
			)
			await writeFile(packageModulePath, '// package internals are outside entry HMR\n', {
				flag: 'a',
			})
			expect(await unexpectedPackageBatch).toMatchObject({ name: 'HmrBatchTimeoutError' })
			expect(host.hmr.api.lastBatch()).toBeNull()

			const entryPath = resolve(root, '.pluxel/managed-plugins/entries/managed.mjs')
			const stagedPath = resolve(root, '.pluxel/managed-plugins/entries/managed.mjs.next')
			const replacementBatch = host.hmr.api.waitForStable({
				afterEpoch: 0,
				timeoutMs: 30_000,
			})
			await writeFile(stagedPath, `${wrapper}// atomically republished\n`)
			await rename(stagedPath, entryPath)
			const replacement = await replacementBatch
			expect(replacement.ok).toBe(true)
			expect(replacement.epoch).toBe(1)

			const replacementStatusOverview = await readRuntimePluginStatusOverview(host.ctx)
			const replacementStatus = replacementStatusOverview.statuses.find((candidate) =>
				pluginNodeAddressEqual(candidate.address, address),
			)
			expect(replacementStatus).toMatchObject({
				recentUpdate: {
					batch: {
						scope: 'definitions',
						sequence: replacement.epoch,
						outcome: 'applied',
						phase: null,
					},
					lifecycle: null,
				},
				execution: {
					kind: 'dynamic-entry',
					artifact: { kind: 'unreported' },
					update: { kind: 'definition-hmr', scope: 'entry-only' },
				},
			})
			expect(JSON.stringify(replacementStatus)).not.toContain(root)
		} finally {
			try {
				await host.stop()
			} finally {
				Reflect.deleteProperty(globalThis, runtimeBridgeKey)
			}
		}
	}, 60_000)

	it('starts fixed source producers only after their generated-source watcher is ready', async () => {
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
				const entriesDir = resolve(root, '.pluxel/managed-plugins/entries')
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
			logging: false,
			printUrls: false,
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
				snapshot: { autoStart: [pluginNodeAddressOf(SourceProducerPlugin)] },
			},
			plugins: [SourceProducerPlugin],
			sources: [
				{
					kind: 'directory',
					path: '.pluxel/managed-plugins/entries',
					include: ['*.ts'],
				},
			],
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
