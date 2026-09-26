import {
	pluginDefinitionAddressEqual,
	type CommitSummary,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	notifyRunningPluginConfigUpdate,
	requireConfigService,
	requirePluginService,
} from '@pluxel/core/internal'
import {
	collectConfigDefaults,
	validateConfigRecord,
	type ConfigValidationErrors as CoreConfigValidationErrors,
} from '@pluxel/core/services'
import { pluginCatalogEntry, type PluginCatalogSnapshot } from './catalog'
import type {
	HostOperationOptions,
	HostPluginGraphExclusiveSession,
	PluginApplyReport,
} from './coordinator'
import type { HostStateSnapshot } from './policy'
import { requirePluginHostCoordinator } from './install'
import type { HostConfigStore, HostConfigSource } from './config-store'
import { mergeRecord } from './config-records'
import { configLeafPaths, changedConfigPaths } from './config-paths'

type ReadonlyConfigValue<T> = T extends object
	? { readonly [K in keyof T]: ReadonlyConfigValue<T[K]> }
	: T
type ConfigValidationErrors = ReadonlyConfigValue<CoreConfigValidationErrors>

export class ConfigMutationRejectedError extends Error {
	readonly code = 'config_mutation_rejected' as const
	constructor(action: string, binding?: { path: readonly string[]; source: string }) {
		super(
			binding
				? `[ConfigService] ${action} is disabled for environment-controlled path ${binding.path.join('.') || '<root>'} (${binding.source}).`
				: `[ConfigService] ${action} is disabled in readonly mode.`,
		)
		this.name = 'ConfigMutationRejectedError'
	}
}

type ConfigSnapshotResult = Readonly<{
	config: Readonly<Record<string, unknown>>
	defaults: Readonly<Record<string, unknown>>
	sources: readonly HostConfigSource[]
}>

type ConfigValueResult = Readonly<{
	config: Readonly<Record<string, unknown>>
	sources: readonly HostConfigSource[]
}>

export type HostPluginConfigResultOk<TReport = PluginApplyReport> =
	| (ConfigSnapshotResult &
			Readonly<{
				ok: true
				saved: false
				application: 'applied' | 'deferred' | 'saved-not-applied'
				desiredRevision: number
				appliedRevision: number | null
			}>)
	| (ConfigValueResult &
			Readonly<{
				ok: true
				saved: true
				application: 'applied' | 'deferred'
				desiredRevision: number
				appliedRevision: number | null
				report: TReport
			}>)
	| (ConfigValueResult &
			Readonly<{
				ok: true
				saved: true
				application: 'saved-not-applied'
				desiredRevision: number
				appliedRevision: number | null
				report: TReport
				applyFailure: Readonly<{
					code: 'listener_not_registered' | 'listener_failed' | 'generation_changed'
					message: string
				}>
			}>)

export type HostPluginConfigResultErr =
	| Readonly<{
			ok: false
			code: 'validation_failed'
			state: 'unchanged'
			message: string
			errors: ConfigValidationErrors
			defaults?: Record<string, unknown>
	  }>
	| Readonly<{
			ok: false
			code: 'invalid_input' | 'node_unavailable' | 'config_not_found' | 'mutation_rejected'
			state: 'unchanged'
			message: string
	  }>
	| (ConfigValueResult & {
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			message: string
	  })

export type HostPluginConfigResult<TReport = PluginApplyReport> =
	| HostPluginConfigResultOk<TReport>
	| HostPluginConfigResultErr

/** Trusted Host config operations. Mutations share the catalog/lifecycle queue and Core revision authority. */
export interface HostPluginConfig {
	get(owner: PluginNodeAddress): Promise<HostPluginConfigResult>
	validate(
		owner: PluginNodeAddress,
		patch: Record<string, unknown>,
	): Promise<HostPluginConfigResult>
	patch(owner: PluginNodeAddress, patch: Record<string, unknown>): Promise<HostPluginConfigResult>
	reset(owner: PluginNodeAddress, keys?: readonly string[]): Promise<HostPluginConfigResult>
}

function plainRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {}
}

type ConfigLookup =
	| Readonly<{
			ok: true
			config: NonNullable<
				ReturnType<typeof pluginCatalogEntry>
			>['candidate']['declaration']['config'] & {}
	  }>
	| Readonly<{
			ok: false
			code: 'node_unavailable' | 'config_not_found'
			state: 'unchanged'
			message: string
	  }>

function configLookup(
	catalog: PluginCatalogSnapshot,
	state: HostStateSnapshot,
	owner: PluginNodeAddress,
): ConfigLookup {
	const entry = pluginCatalogEntry(catalog, owner.definition)
	if (
		!entry ||
		(owner.variant === 'fork' &&
			(!entry.candidate.declaration.forkable ||
				!state.forks.some(
					(fork) =>
						pluginDefinitionAddressEqual(fork.definition, owner.definition) &&
						fork.forkIds.includes(owner.forkId),
				)))
	) {
		return {
			ok: false,
			code: 'node_unavailable',
			state: 'unchanged',
			message: 'Plugin node is unavailable in the committed runtime graph policy.',
		}
	}
	const config = entry.candidate.declaration.config
	if (!config) {
		return {
			ok: false,
			code: 'config_not_found',
			state: 'unchanged',
			message: 'No config schema is registered for this Plugin node.',
		}
	}
	return { ok: true, config }
}

export function lookupPluginConfig(
	ctx: Context,
	owner: PluginNodeAddress,
	options?: HostOperationOptions,
): Promise<ConfigLookup> {
	return requirePluginHostCoordinator(ctx).readCommitted(
		(view) => configLookup(view.catalog, view.runtimeState.state, owner),
		options,
	)
}

function configApplicationState(ctx: Context, owner: PluginNodeAddress) {
	const configService = requireConfigService(ctx) as HostConfigStore
	const desiredRevision = configService.getConfigRevision(owner)
	const appliedRevision = configService.getAppliedConfigRevision(owner)
	return {
		desiredRevision,
		appliedRevision,
		application: !requirePluginService(ctx).isRunning(owner)
			? ('deferred' as const)
			: appliedRevision === desiredRevision
				? ('applied' as const)
				: ('saved-not-applied' as const),
	}
}

export async function pluginConfigGet(
	ctx: Context,
	owner: PluginNodeAddress,
	options?: HostOperationOptions,
): Promise<HostPluginConfigResult> {
	const coordinator = requirePluginHostCoordinator(ctx)
	return coordinator.runExclusive(
		'plugin-config-read',
		async (session) => {
			const configService = requireConfigService(ctx) as HostConfigStore
			const lookup = configLookup(
				coordinator.catalogSnapshot(),
				session.runtimeStateSnapshot(),
				owner,
			)
			if (lookup.ok === false) return lookup
			return {
				ok: true,
				saved: false,
				...configApplicationState(ctx, owner),
				config: plainRecord(configService.getRawConfig(owner)),
				sources: configService.getConfigSources(owner),
				defaults: await collectConfigDefaults(lookup.config.schema, {
					missingObjectDefault: {},
				}),
			}
		},
		options,
	)
}

export async function pluginConfigValidate(
	ctx: Context,
	owner: PluginNodeAddress,
	patch: Record<string, unknown>,
	options?: HostOperationOptions,
): Promise<HostPluginConfigResult> {
	const coordinator = requirePluginHostCoordinator(ctx)
	return coordinator.runExclusive(
		'plugin-config-read',
		async (session) => {
			const configService = requireConfigService(ctx) as HostConfigStore
			const lookup = configLookup(
				coordinator.catalogSnapshot(),
				session.runtimeStateSnapshot(),
				owner,
			)
			if (lookup.ok === false) return lookup
			let candidate: Record<string, unknown>
			try {
				configService.assertPathsMutable(owner, configLeafPaths(patch))
				candidate = configService.composeConfig(
					owner,
					mergeRecord(configService.getManagedConfig(owner), patch),
				)
			} catch (error) {
				if (error instanceof ConfigMutationRejectedError)
					return {
						ok: false,
						code: 'mutation_rejected',
						state: 'unchanged',
						message: error.message,
					}
				throw error
			}
			const [defaults, validation] = await Promise.all([
				collectConfigDefaults(lookup.config.schema, { missingObjectDefault: {} }),
				validateConfigRecord(lookup.config.schema, candidate),
			])
			if (validation.ok === false) {
				return {
					ok: false,
					code: 'validation_failed',
					state: 'unchanged',
					message: 'Validation failed',
					errors: validation.errors,
					defaults,
				}
			}
			return {
				ok: true,
				saved: false,
				...configApplicationState(ctx, owner),
				config: validation.output,
				sources: configService.getConfigSources(owner),
				defaults,
			}
		},
		options,
	)
}

async function applyDesiredConfig(
	ctx: Context,
	owner: PluginNodeAddress,
	session: HostPluginGraphExclusiveSession<CommitSummary>,
	desired: Readonly<Record<string, unknown>>,
	desiredRevision: number,
): Promise<
	| {
			application: 'applied' | 'deferred'
			report: PluginApplyReport
	  }
	| {
			application: 'saved-not-applied'
			report: PluginApplyReport
			applyFailure: {
				code: 'listener_not_registered' | 'listener_failed' | 'generation_changed'
				message: string
			}
	  }
> {
	if (!requirePluginService(ctx).isRunning(owner)) {
		return { application: 'deferred', report: session.report() }
	}
	const notification = await notifyRunningPluginConfigUpdate(
		requirePluginService(ctx),
		owner,
		desired,
		desiredRevision,
	)
	const projected = session.report()
	if (notification.status === 'applied') {
		return { application: 'applied', report: projected }
	}
	const messages = {
		listener_not_registered: 'A changed config declaration has no update listener.',
		listener_failed: 'A Plugin config update listener failed.',
		generation_changed: 'The Plugin generation changed before the config update was confirmed.',
	} as const
	return {
		application: 'saved-not-applied',
		report: projected,
		applyFailure: {
			code: notification.status,
			message: messages[notification.status],
		},
	}
}

export async function mutatePluginConfig(
	ctx: Context,
	owner: PluginNodeAddress,
	reason: string,
	buildCandidate: (current: Record<string, unknown>) => Record<string, unknown>,
	options?: HostOperationOptions,
	requestedPaths?: readonly (readonly string[])[],
): Promise<HostPluginConfigResult> {
	const coordinator = requirePluginHostCoordinator(ctx)
	return await coordinator.runExclusive(
		reason,
		async (session) => {
			const configService = requireConfigService(ctx) as HostConfigStore
			const lookup = configLookup(
				coordinator.catalogSnapshot(),
				session.runtimeStateSnapshot(),
				owner,
			)
			if (lookup.ok === false) return lookup
			const current = configService.getManagedConfig(owner)
			const expectedRevision = configService.getConfigRevision(owner)
			let managed: Record<string, unknown>
			let paths: readonly (readonly string[])[]
			try {
				managed = buildCandidate(current)
				paths = requestedPaths ?? changedConfigPaths(current, managed)
				configService.assertPathsMutable(owner, paths)
			} catch (error) {
				if (error instanceof ConfigMutationRejectedError)
					return {
						ok: false,
						code: 'mutation_rejected',
						state: 'unchanged',
						message: error.message,
					}
				throw error
			}
			const candidate = configService.composeConfig(owner, managed)
			const validation = await validateConfigRecord(lookup.config.schema, candidate)
			if (validation.ok === false) {
				return {
					ok: false,
					code: 'validation_failed',
					state: 'unchanged',
					message: 'Validation failed.',
					errors: validation.errors,
				}
			}
			let staged: ReturnType<typeof configService.stageValidatedConfig>
			try {
				staged = configService.stageManagedConfig({
					owner,
					authority: lookup.config,
					expectedRevision,
					value: validation.output,
					managed,
					paths,
				})
			} catch (error) {
				if (error instanceof ConfigMutationRejectedError) {
					return {
						ok: false,
						code: 'mutation_rejected',
						state: 'unchanged',
						message: error.message,
					}
				}
				throw error
			}
			try {
				await configService.flush()
			} catch (error) {
				return {
					ok: false,
					code: 'persistence_failed',
					state: 'unknown',
					message: errorText(error),
					config: plainRecord(configService.getRawConfig(owner)),
					sources: configService.getConfigSources(owner),
				}
			}
			const desired = configService.confirmValidatedConfig(staged)
			const applied = await applyDesiredConfig(ctx, owner, session, desired, staged.revision)
			return {
				ok: true,
				saved: true,
				...applied,
				desiredRevision: configService.getConfigRevision(owner),
				appliedRevision: configService.getAppliedConfigRevision(owner),
				config: plainRecord(configService.getRawConfig(owner)),
				sources: configService.getConfigSources(owner),
			}
		},
		options,
	)
}

export async function pluginConfigPatch(
	ctx: Context,
	owner: PluginNodeAddress,
	patch: Record<string, unknown>,
	options?: HostOperationOptions,
): Promise<HostPluginConfigResult> {
	return await mutatePluginConfig(
		ctx,
		owner,
		'plugin-config-patch',
		(current) => mergeRecord(current, patch),
		options,
		configLeafPaths(patch),
	)
}

export async function pluginConfigReset(
	ctx: Context,
	owner: PluginNodeAddress,
	keys?: readonly string[],
	options?: HostOperationOptions,
): Promise<HostPluginConfigResult> {
	return await mutatePluginConfig(
		ctx,
		owner,
		'plugin-config-reset',
		(current) => {
			const candidate = { ...current }
			for (const key of keys?.length ? keys : Object.keys(candidate)) delete candidate[key]
			return candidate
		},
		options,
		keys?.length ? keys.map((key) => [key]) : [[]],
	)
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
