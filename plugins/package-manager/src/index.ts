import { assertWorkbenchDto } from '@pluxel/workbench/server'
import { Commands } from '@pluxel/services/commands'
import { resolve } from 'node:path'
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { BasePlugin, Plugin } from '@pluxel/core'
import * as f from 'valibot-form'
import * as v from 'valibot'
import { RpcTarget } from 'capnweb'
import { requireDynamicPluginSource } from '@pluxel/host/dynamic/source-producer'
import type {
	PackageManagerApi,
	PackageManagerSnapshot,
	PackageMutationResult,
} from './contracts.ts'
import { loadPnpmEngine } from './pnpm-engine.ts'
import { ManagedPackageStore } from './store.ts'
import { PackageManagerWorkbench } from './workbench.ts'

export const PackageManagerConfig = v.object({
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
const mutationFailureOutput = Type.Object(
	{
		input: Type.String(),
		code: Type.Union([
			Type.Literal('INVALID_SPEC'),
			Type.Literal('INSTALL_FAILED'),
			Type.Literal('REMOVE_FAILED'),
		]),
		message: Type.String(),
	},
	{ additionalProperties: false },
)
const mutationOutput = obj({
	ok: Type.Boolean(),
	succeeded: Type.Array(Type.String()),
	failed: Type.Array(mutationFailureOutput),
})

@Plugin({ startTimeoutMs: 120_000 })
export class PackageManagerPlugin extends BasePlugin {
	private readonly config = this.configs.use(PackageManagerConfig)
	private store?: ManagedPackageStore

	override async init(signal: AbortSignal): Promise<void> {
		const rootDir = resolve(process.cwd(), this.config.rootDir)
		requireDynamicPluginSource(this.ctx, {
			kind: 'directory',
			path: resolve(rootDir, 'entries'),
			include: ['*.mjs'],
		})
		const store = new ManagedPackageStore(await loadPnpmEngine(), {
			rootDir,
			ignoreScripts: this.config.ignoreScripts,
			allowBuilds: this.config.allowBuilds,
			minimumReleaseAgeMinutes: this.config.minimumReleaseAgeMinutes,
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
				name: 'package.install',
				description: 'Install plugin packages into the managed dynamic source project.',
				behavior: { kind: 'mutation', destructive: false, idempotent: true, world: 'open' },
				input: mutationInput,
				output: mutationOutput,
				execute: async ({ specs }) => toCommandMutation(await store.install(specs)),
			}),
		)
		this.ctx.require(Commands).register(
			defineCommand({
				name: 'package.remove',
				description: 'Remove plugin packages from the managed dynamic source project.',
				behavior: { kind: 'mutation', destructive: true, idempotent: false, world: 'open' },
				input: mutationInput,
				output: mutationOutput,
				execute: async ({ specs }) => toCommandMutation(await store.remove(specs)),
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
} from './contracts.ts'
