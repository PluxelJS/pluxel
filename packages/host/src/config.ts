import {
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type CommitSummary,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	notifyRunningPluginConfigUpdate,
	requireConfigService,
	requirePluginService,
	immutableConfigRecord,
} from '@pluxel/core/internal'
import {
	ConfigValidationError,
	type ConfigValidationErrors as CoreConfigValidationErrors,
} from '@pluxel/core/services'
import {
	assertPluginControlContract,
	pluginCatalogEntry,
	type PluginCatalogSnapshot,
} from './catalog'
import type {
	HostOperationOptions,
	HostPluginGraphExclusiveSession,
	PluginApplyReport,
} from './coordinator'
import type { HostStateSnapshot } from './policy'
import { requirePluginHostCoordinator } from './install'
import type { HostConfigStore, HostConfigSource } from './config-store'
import {
	assertDataObject,
	mergeRecord,
	snapshotConfigInput,
	type ConfigInputPatch,
} from './config-records'
import type { HostInputMode } from './input-mode'
import type { HostPersistenceResult } from './persistence'
import { assertConfigPaths, removeConfigPaths } from './config-paths'
import { hash as ohash } from 'ohash'

type ReadonlyConfigValue<T> = T extends object
	? { readonly [K in keyof T]: ReadonlyConfigValue<T[K]> }
	: T
type ConfigValidationErrors = ReadonlyConfigValue<CoreConfigValidationErrors>

export class ConfigMutationRejectedError extends Error {
	readonly code = 'config_mutation_rejected' as const
	constructor(action: string) {
		super(`[ConfigService] ${action} is disabled because config documents are readonly.`)
		this.name = 'ConfigMutationRejectedError'
	}
}

export type HostConfigMutation<I = Readonly<Record<string, unknown>>> = Readonly<{
	set?: ConfigInputPatch<I> & object
	remove?: readonly (readonly string[])[]
}>
export type HostConfigInputSnapshot = Readonly<{
	readonly: boolean
	mode: HostInputMode
	managedInput: Readonly<Record<string, unknown>> | null
	effectiveInput: Readonly<Record<string, unknown>>
	sources: readonly HostConfigSource[]
	shadowedPaths: readonly (readonly string[])[]
	managedRevision: string
}>
type ConfigValueResult<O extends object = Readonly<Record<string, unknown>>> =
	HostConfigInputSnapshot & Readonly<{ config: ReadonlyConfigValue<O> }>
export type HostPluginConfigResultOk<
	TReport = PluginApplyReport,
	O extends object = Readonly<Record<string, unknown>>,
> = ConfigValueResult<O> &
	Readonly<{
		ok: true
		persistence: HostPersistenceResult
		application: 'applied' | 'deferred' | 'saved-not-applied'
		desiredRevision: number
		appliedRevision: number | null
		report?: TReport
		applyFailure?: Readonly<{
			code: 'listener_not_registered' | 'listener_failed' | 'generation_changed'
			message: string
		}>
	}>
export type HostPluginConfigResultErr =
	| (HostConfigInputSnapshot &
			Readonly<{
				ok: false
				code: 'validation_failed'
				state: 'unchanged'
				message: string
				errors: ConfigValidationErrors
			}>)
	| Readonly<{
			ok: false
			code: 'invalid_input' | 'node_unavailable' | 'config_not_found' | 'mutation_rejected'
			state: 'unchanged'
			message: string
	  }>
	| Readonly<{
			ok: false
			code: 'revision_conflict'
			state: 'unchanged'
			message: string
			managedRevision: string
	  }>
	| (HostConfigInputSnapshot &
			Readonly<{
				ok: false
				code: 'persistence_failed'
				state: 'unknown'
				message: string
				persistence: Readonly<{ status: 'unknown' }>
			}>)
export type HostPluginConfigResult<
	TReport = PluginApplyReport,
	O extends object = Readonly<Record<string, unknown>>,
> = HostPluginConfigResultOk<TReport, O> | HostPluginConfigResultErr

/** Raw input edits, validation and reads share the catalog/lifecycle queue. */
export interface HostPluginConfig {
	status(): HostConfigState
	get(owner: PluginNodeAddress): Promise<HostPluginConfigResult>
	validate(owner: PluginNodeAddress, change: HostConfigMutation): Promise<HostPluginConfigResult>
	patch(
		owner: PluginNodeAddress,
		change: HostConfigMutation,
		options?: HostOperationOptions,
	): Promise<HostPluginConfigResult>
	reset(
		owner: PluginNodeAddress,
		paths?: readonly (readonly string[])[],
		options?: HostOperationOptions,
	): Promise<HostPluginConfigResult>
}

export type HostConfigState = Readonly<{ readonly: boolean }>

export function readHostConfigState(ctx: Context): HostConfigState {
	const service = requireConfigService(ctx) as HostConfigStore
	return Object.freeze({ readonly: service.isReadonly })
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
	expectedControlContract?: string | null,
): ConfigLookup {
	const entry = pluginCatalogEntry(catalog, owner.definition)
	if (
		!entry ||
		(owner.variant === 'fork' &&
			(!entry.candidate.declaration.forkable ||
				!state.forks.some((fork) => pluginNodeAddressEqual(fork, owner))))
	) {
		return {
			ok: false,
			code: 'node_unavailable',
			state: 'unchanged',
			message: 'Plugin node is unavailable in the committed runtime graph policy.',
		}
	}
	if (expectedControlContract !== undefined)
		assertPluginControlContract(entry, 'config', expectedControlContract)
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

function inputSnapshot(
	store: HostConfigStore,
	owner: PluginNodeAddress,
	managed = store.getManagedInput(owner),
): HostConfigInputSnapshot {
	return Object.freeze({
		readonly: store.isReadonly,
		mode: store.getMode(owner),
		managedInput: managed,
		effectiveInput: snapshotConfigInput(store.composeConfig(owner, managed)),
		sources: store.getConfigSources(owner, managed),
		shadowedPaths: store.getShadowedPaths(owner, managed),
		managedRevision: store.managedRevision,
	})
}
function snapshot(
	store: HostConfigStore,
	owner: PluginNodeAddress,
	output: Readonly<Record<string, unknown>>,
	managed = store.getManagedInput(owner),
): ConfigValueResult {
	return Object.freeze({
		...inputSnapshot(store, owner, managed),
		config: immutableConfigRecord(output),
	})
}
function failure(error: unknown): HostPluginConfigResultErr {
	return {
		ok: false,
		code: error instanceof ConfigMutationRejectedError ? 'mutation_rejected' : 'invalid_input',
		state: 'unchanged',
		message: errorText(error),
	}
}
function changeInput(
	current: Readonly<Record<string, unknown>> | null,
	change: HostConfigMutation,
): Readonly<Record<string, unknown>> | null {
	assertDataObject(change, 'config mutation', ['set', 'remove'])
	if (change.remove !== undefined) assertConfigPaths(change.remove)
	const set = change.set === undefined ? undefined : snapshotConfigInput(change.set)
	const candidate = mergeRecord(undefined, current ?? undefined)
	const removed = removeConfigPaths(candidate, change.remove ?? [])
	const next = mergeRecord(candidate, set)
	if (Object.keys(next).length === 0 && (removed || (current === null && set === undefined)))
		return null
	return snapshotConfigInput(next)
}

export async function pluginConfigGet(
	ctx: Context,
	owner: PluginNodeAddress,
	options?: HostOperationOptions,
	expectedControlContract?: string | null,
): Promise<HostPluginConfigResult> {
	const coordinator = requirePluginHostCoordinator(ctx)
	return coordinator.runExclusive(
		'plugin-config-read',
		async (session) => {
			const store = requireConfigService(ctx) as HostConfigStore
			const lookup = configLookup(
				coordinator.catalogSnapshot(),
				session.runtimeStateSnapshot(),
				owner,
				expectedControlContract,
			)
			if (lookup.ok === false) return lookup
			let output: Readonly<Record<string, unknown>>
			try {
				output = await store.ensureValidated(owner, lookup.config)
			} catch (error) {
				if (error instanceof ConfigValidationError)
					return {
						ok: false,
						code: 'validation_failed',
						state: 'unchanged',
						message: 'Validation failed.',
						errors: error.errors,
						...inputSnapshot(store, owner),
					}
				throw error
			}
			return {
				ok: true,
				persistence: { status: 'unchanged' },
				...snapshot(store, owner, output),
				...configApplicationState(ctx, owner),
			}
		},
		options,
	)
}
export async function pluginConfigValidate(
	ctx: Context,
	owner: PluginNodeAddress,
	change: HostConfigMutation,
	options?: HostOperationOptions,
	expectedControlContract?: string | null,
): Promise<HostPluginConfigResult> {
	const coordinator = requirePluginHostCoordinator(ctx)
	return coordinator.runExclusive(
		'plugin-config-read',
		async (session) => {
			const store = requireConfigService(ctx) as HostConfigStore
			const lookup = configLookup(
				coordinator.catalogSnapshot(),
				session.runtimeStateSnapshot(),
				owner,
				expectedControlContract,
			)
			if (lookup.ok === false) return lookup
			let managed: Readonly<Record<string, unknown>> | null
			try {
				managed = changeInput(store.getManagedInput(owner), change)
			} catch (error) {
				if (error instanceof TypeError) return failure(error)
				throw error
			}
			const validation = await store.validateEffective(
				owner,
				lookup.config,
				store.composeConfig(owner, managed),
			)
			if (validation.ok === false)
				return {
					ok: false,
					code: 'validation_failed',
					state: 'unchanged',
					message: 'Validation failed.',
					errors: validation.errors,
					...inputSnapshot(store, owner, managed),
				}
			return {
				ok: true,
				persistence: { status: 'unchanged' },
				...snapshot(store, owner, validation.output, managed),
				...configApplicationState(ctx, owner),
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

async function mutatePluginConfig(
	ctx: Context,
	owner: PluginNodeAddress,
	reason: string,
	build: (
		current: Readonly<Record<string, unknown>> | null,
	) => Readonly<Record<string, unknown>> | null,
	options?: HostOperationOptions,
	expectedControlContract?: string | null,
): Promise<HostPluginConfigResult> {
	const coordinator = requirePluginHostCoordinator(ctx)
	return coordinator.runExclusive(
		reason,
		async (session) => {
			const store = requireConfigService(ctx) as HostConfigStore
			if (
				options?.expectedManagedRevision !== undefined &&
				options.expectedManagedRevision !== store.managedRevision
			)
				return {
					ok: false,
					code: 'revision_conflict',
					state: 'unchanged',
					message: 'Managed config changed; refresh before editing.',
					managedRevision: store.managedRevision,
				}
			const lookup = configLookup(
				coordinator.catalogSnapshot(),
				session.runtimeStateSnapshot(),
				owner,
				expectedControlContract,
			)
			if (lookup.ok === false) return lookup
			let managed: Readonly<Record<string, unknown>> | null
			try {
				store.assertManagedMutation()
				managed = build(store.getManagedInput(owner))
			} catch (error) {
				if (error instanceof TypeError || error instanceof ConfigMutationRejectedError)
					return failure(error)
				throw error
			}
			const effective = store.composeConfig(owner, managed)
			const validation = await store.validateEffective(owner, lookup.config, effective)
			if (validation.ok === false)
				return {
					ok: false,
					code: 'validation_failed',
					state: 'unchanged',
					message: 'Validation failed.',
					errors: validation.errors,
					...inputSnapshot(store, owner, managed),
				}
			const staged = store.stageManagedConfig({
				owner,
				authority: lookup.config,
				expectedRevision: store.getConfigRevision(owner),
				value: validation.output,
				managed,
			})
			try {
				await store.flush()
			} catch (error) {
				store.discardManagedConfig(staged)
				return {
					ok: false,
					code: 'persistence_failed',
					state: 'unknown',
					message: errorText(error),
					persistence: { status: 'unknown' },
					...inputSnapshot(store, owner),
				}
			}
			const output = store.confirmManagedConfig(staged)
			const applied = staged.desiredChanged
				? await applyDesiredConfig(ctx, owner, session, output, store.getConfigRevision(owner))
				: configApplicationState(ctx, owner)
			return {
				ok: true,
				persistence: staged.changed
					? { status: 'confirmed', retention: store.retention }
					: { status: 'unchanged' },
				...snapshot(store, owner, output),
				...configApplicationState(ctx, owner),
				...applied,
			}
		},
		options,
	)
}

/** External documents are validated completely before publishing any raw input or output. */
export async function reloadSavedConfig(
	ctx: Context,
	catalogSnapshot: () => PluginCatalogSnapshot,
): Promise<void> {
	const coordinator = requirePluginHostCoordinator(ctx)
	await coordinator.runExclusive('config-file-reload', async (session) => {
		const store = requireConfigService(ctx) as HostConfigStore
		const document = await store.readExternal()
		if (!document) return
		const owners = new Map(
			[...store.getManagedRecords(), ...document.records].map((entry) => [
				pluginNodeIndexKey(entry.owner),
				entry.owner,
			]),
		)
		const validated: Parameters<HostConfigStore['acceptExternal']>[1][number][] = []
		for (const owner of owners.values()) {
			const lookup = configLookup(catalogSnapshot(), session.runtimeStateSnapshot(), owner)
			if (lookup.ok === false) continue
			const managed =
				document.records.find((entry) => pluginNodeAddressEqual(entry.owner, owner))?.config ?? null
			const effective = store.composeConfig(owner, managed)
			if (
				ohash(store.composeConfig(owner)) === ohash(effective) &&
				store.tryGetValidatedConfig(owner, lookup.config)
			)
				continue
			const result = await store.validateEffective(owner, lookup.config, effective)
			if (result.ok === false)
				throw new Error('[host:config] External document rejected by a Plugin config schema', {
					cause: result.errors,
				})
			validated.push({
				owner,
				authority: lookup.config,
				expectedRevision: store.getConfigRevision(owner),
				value: result.output,
				effective,
			})
		}
		const updates = store.acceptExternal(document, validated)
		for (const update of updates)
			await applyDesiredConfig(ctx, update.owner, session, update.snapshot, update.revision)
	})
}
export async function pluginConfigPatch(
	ctx: Context,
	owner: PluginNodeAddress,
	change: HostConfigMutation,
	options?: HostOperationOptions,
	expectedControlContract?: string | null,
): Promise<HostPluginConfigResult> {
	return mutatePluginConfig(
		ctx,
		owner,
		'plugin-config-patch',
		(current) => changeInput(current, change),
		options,
		expectedControlContract,
	)
}
export async function pluginConfigReset(
	ctx: Context,
	owner: PluginNodeAddress,
	paths?: readonly (readonly string[])[],
	options?: HostOperationOptions,
	expectedControlContract?: string | null,
): Promise<HostPluginConfigResult> {
	if (paths?.length === 0) return pluginConfigGet(ctx, owner, options, expectedControlContract)
	return mutatePluginConfig(
		ctx,
		owner,
		'plugin-config-reset',
		(current) => (paths === undefined ? null : changeInput(current, { remove: paths })),
		options,
		expectedControlContract,
	)
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
