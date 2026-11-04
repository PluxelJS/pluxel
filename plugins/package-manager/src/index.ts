import { assertWorkbenchDto } from '@pluxel/workbench/server'
import { Commands } from '@pluxel/services/commands'
import { resolve } from 'node:path'
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { BasePlugin, Plugin } from '@pluxel/core'
import * as f from 'valibot-form'
import * as v from 'valibot'
import { RpcTarget } from 'capnweb'
import { requirePluginSource } from '@pluxel/host/sources'
import type {
	PackageManagerApi,
	PackageManagerSnapshot,
	PackageMutationResult,
	PackagePreparationResult,
	MarketInstallRequest,
	MarketPackageQuery,
	MarketReleaseQuery,
} from './contracts.ts'
import { loadPnpmEngine } from './pnpm-engine.ts'
import { ManagedPackageStore } from './store.ts'
import { PackageManagerWorkbench } from './workbench.ts'

export const PackageManagerConfig = v.object({
	markets: v.pipe(
		v.optional(
			v.array(
				v.object({
					id: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,64}$/)),
					url: v.pipe(
						v.string(),
						v.url(),
						v.check((input) => {
							try {
								const url = new URL(input)
								return (
									['http:', 'https:'].includes(url.protocol) &&
									!url.username &&
									!url.password &&
									!url.search &&
									!url.hash
								)
							} catch {
								return false
							}
						}, 'Expected an HTTP(S) base URL without credentials, query or fragment'),
					),
				}),
			),
			[],
		),
		v.check(
			(markets) => new Set(markets.map(({ id }) => id)).size === markets.length,
			'Market ids must be unique',
		),
		f.formMeta({
			title: 'Plugin markets',
			description: 'Optional HTTP package catalogs. Direct installation works without a market.',
		}),
	),
	rootDir: v.pipe(
		v.optional(v.string(), '.pluxel/managed-plugins'),
		f.formMeta({
			title: 'Managed package root',
			description: 'Dedicated pnpm project used to materialize dynamically loaded plugin packages.',
		}),
	),
	ignoreScripts: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({
			title: 'Ignore dependency scripts',
			description: 'Safe by default. Disable only together with an explicit build allow-list.',
		}),
	),
	allowBuilds: v.pipe(
		v.optional(v.array(v.string()), []),
		f.formMeta({
			title: 'Allowed build packages',
			description: 'Exact package names allowed to execute dependency build scripts.',
		}),
	),
	minimumReleaseAgeMinutes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 1_440),
		f.formMeta({
			title: 'Minimum release age',
			description: 'Reject package releases newer than this many minutes.',
		}),
	),
})

export type PackageManagerPluginConfig = v.InferOutput<typeof PackageManagerConfig>

const mutationInput = obj({
	specs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
		minItems: 1,
		maxItems: 100,
	}),
})

@Plugin({ startTimeoutMs: 120_000 })
export class PackageManagerPlugin extends BasePlugin {
	private readonly config = this.configs.use(PackageManagerConfig)
	private store?: ManagedPackageStore

	override async init(signal: AbortSignal): Promise<void> {
		const rootDir = resolve(process.cwd(), this.config.rootDir)
		const source = requirePluginSource(this.ctx, {
			kind: 'directory',
			path: resolve(rootDir, 'entries'),
			include: ['*.mjs'],
		})
		const store = new ManagedPackageStore(await loadPnpmEngine(), {
			rootDir,
			ignoreScripts: this.config.ignoreScripts,
			allowBuilds: this.config.allowBuilds,
			minimumReleaseAgeMinutes: this.config.minimumReleaseAgeMinutes,
			markets: this.config.markets,
			sourceUpdates: source.updates,
			signal,
		})
		this.ctx.effects.defer(() => store.close())
		await store.initialize()
		this.store = store
		this.ctx.effects.defer(() => {
			if (this.store === store) this.store = undefined
		})

		this.ctx.require(Commands).register(
			defineCommand({
				name: 'package.prepare',
				description:
					'Download and prepare plugin packages for review without publishing source entries.',
				input: mutationInput,
				execute: async ({ specs }) => Result.ok(await store.prepareInstall(specs)),
			}),
		)
		this.ctx.require(Commands).register(
			defineCommand({
				name: 'package.confirm',
				description: 'Publish a prepared installation; does not activate Plugin instances.',
				input: obj({ planId: Type.String({ minLength: 1, maxLength: 64 }) }),
				execute: async ({ planId }) =>
					Result.ok(toCommandMutation(await store.confirmInstall(planId))),
			}),
		)
		this.ctx.require(Commands).register(
			defineCommand({
				name: 'package.install',
				description: 'Install plugin packages into the managed dynamic source project.',
				input: mutationInput,
				execute: async ({ specs }) => Result.ok(toCommandMutation(await store.install(specs))),
			}),
		)
		this.ctx.require(Commands).register(
			defineCommand({
				name: 'package.remove',
				description: 'Remove plugin packages from the managed dynamic source project.',
				input: mutationInput,
				execute: async ({ specs }) => Result.ok(toCommandMutation(await store.remove(specs))),
			}),
		)
		this.ctx.workbench?.publish(PackageManagerWorkbench, {
			manager: () => new PackageManagerTarget(store),
		})
	}

	snapshot(): Promise<PackageManagerSnapshot> {
		return this.requireStore().snapshot()
	}

	install(specs: readonly string[]): Promise<PackageMutationResult> {
		return this.requireStore().install(specs)
	}

	prepareInstall(specs: readonly string[]): Promise<PackagePreparationResult> {
		return this.requireStore().prepareInstall(specs)
	}

	confirmInstall(planId: string): Promise<PackageMutationResult> {
		return this.requireStore().confirmInstall(planId)
	}

	marketPackages(marketId: string, query?: MarketPackageQuery) {
		return this.requireStore().marketPackages(marketId, query)
	}

	marketRelease(marketId: string, name: string, version: string) {
		return this.requireStore().marketRelease(marketId, name, version)
	}

	marketReleases(marketId: string, name: string, query?: MarketReleaseQuery) {
		return this.requireStore().marketReleases(marketId, name, query)
	}

	prepareMarketInstall(request: MarketInstallRequest): Promise<PackagePreparationResult> {
		return this.requireStore().prepareMarketInstall(request)
	}

	remove(names: readonly string[]): Promise<PackageMutationResult> {
		return this.requireStore().remove(names)
	}

	private requireStore(): ManagedPackageStore {
		if (!this.store) throw new Error('PackageManagerPlugin is not running')
		return this.store
	}
}

function toCommandMutation(result: PackageMutationResult) {
	return {
		ok: result.ok,
		succeeded: [...result.succeeded],
		failed: result.failed.map((failure) => ({ ...failure })),
	}
}

class PackageManagerTarget extends RpcTarget implements PackageManagerApi {
	constructor(private readonly store: ManagedPackageStore) {
		super()
	}

	async snapshotDto(): Promise<PackageManagerSnapshot> {
		const result = await this.store.snapshot()
		assertWorkbenchDto(result)
		return result
	}

	async installDto(specs: readonly string[]): Promise<PackageMutationResult> {
		const result = await this.store.install(specs)
		assertWorkbenchDto(result)
		return result
	}

	async prepareInstallDto(specs: readonly string[]) {
		const result = await this.store.prepareInstall(specs)
		assertWorkbenchDto(result)
		return result
	}

	async confirmInstallDto(planId: string) {
		const result = await this.store.confirmInstall(planId)
		assertWorkbenchDto(result)
		return result
	}

	async marketPackagesDto(marketId: string, query?: MarketPackageQuery) {
		const result = await this.store.marketPackages(marketId, query)
		assertWorkbenchDto(result)
		return result
	}

	async marketReleaseDto(marketId: string, name: string, version: string) {
		const result = await this.store.marketRelease(marketId, name, version)
		assertWorkbenchDto(result)
		return result
	}

	async marketReleasesDto(marketId: string, name: string, query?: MarketReleaseQuery) {
		const result = await this.store.marketReleases(marketId, name, query)
		assertWorkbenchDto(result)
		return result
	}

	async prepareMarketInstallDto(request: MarketInstallRequest) {
		const result = await this.store.prepareMarketInstall(request)
		assertWorkbenchDto(result)
		return result
	}

	async removeDto(names: readonly string[]): Promise<PackageMutationResult> {
		const result = await this.store.remove(names)
		assertWorkbenchDto(result)
		return result
	}
}

export type {
	ManagedPackage,
	PackageManagerApi,
	PackageManagerSnapshot,
	PackageMutationFailure,
	PackageMutationResult,
	PackageMarket,
	PackageInstallPlan,
	PackagePreparationResult,
	MarketInstallRequest,
	MarketPackageQuery,
	MarketPackageSummary,
	MarketPackagePage,
	MarketRelease,
	MarketReleasePage,
	MarketReleaseQuery,
	MarketReadResult,
} from './contracts.ts'
