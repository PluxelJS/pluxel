import { type CommitSummary, type Context, type PluginNodeAddress } from '@pluxel/core'
import {
	notifyRunningPluginConfigUpdate,
	requireConfigService,
	requirePluginService,
} from '@pluxel/core/internal'
import { collectConfigDefaults, validateConfigRecord } from '@pluxel/core/services'
import type { ConfigPresentationResult, ConfigResult, PluginApplyReport } from '../../web/protocol'
import {
	pluginCatalogEntry,
	requireRuntimePluginGraphCoordinator,
	type PluginRouteCatalogSnapshot,
	type RuntimePluginGraphExclusiveSession,
} from '../../internal/reconciliation'
import { requireRuntimeStateStore } from '../../internal/runtime-state'
import { listForkIds } from '../../services/RuntimeStateHelpers'
import type { RuntimeStateSnapshot } from '../../services/RuntimeStateStore'
import { ConfigMutationRejectedError } from '../../services/ConfigService'
import { projectPluginApplyReport } from '../presenters/pluginApplyReport'
import { compileConfigPresentationPlanV1 } from '../presenters/configPresentation'
import { parseConfigFieldPathSegments } from '../../web/validation'

export type PluginConfigPresentationResult = ConfigPresentationResult

export type PluginConfigPresentationSection = Readonly<{
	path: readonly string[]
	fieldName: string
	schema: Parameters<typeof compileConfigPresentationPlanV1>[0]['schema']
	defaults: Record<string, unknown>
}>

export type PluginConfigResult = ConfigResult

function plainRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {}
}

function writeNestedField(
	source: Record<string, unknown>,
	segments: readonly string[],
	value: unknown,
): Record<string, unknown> {
	const out = { ...source }
	let cursor = out
	for (let index = 0; index < segments.length - 1; index++) {
		const key = segments[index]!
		const next = plainRecord(cursor[key])
		cursor[key] = next
		cursor = next
	}
	cursor[segments.at(-1)!] = value
	return out
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
	catalog: PluginRouteCatalogSnapshot,
	state: RuntimeStateSnapshot,
	owner: PluginNodeAddress,
): ConfigLookup {
	const entry = pluginCatalogEntry(catalog, owner.definition)
	if (
		!entry ||
		(owner.variant === 'fork' &&
			(!entry.candidate.declaration.forkable ||
				!listForkIds(state, owner.definition).includes(owner.forkId)))
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

function currentConfigLookup(ctx: Context, owner: PluginNodeAddress): ConfigLookup {
	return configLookup(
		requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot(),
		requireRuntimeStateStore(ctx).snapshot(),
		owner,
	)
}

export async function pluginConfigPresentation(
	ctx: Context,
	owner: PluginNodeAddress,
): Promise<PluginConfigPresentationResult> {
	const lookup = currentConfigLookup(ctx, owner)
	if (lookup.ok === false) {
		return {
			ok: false,
			code: lookup.code === 'config_not_found' ? 'presentation_not_found' : lookup.code,
			message: lookup.message,
		}
	}
	const config = lookup.config
	const declarations = [
		...(config.owner ? [{ path: Object.freeze([] as string[]), declaration: config.owner }] : []),
		...config.parts.flatMap((part) =>
			part.declaration ? [{ path: part.path, declaration: part.declaration }] : [],
		),
	]
	const sections = await Promise.all(
		declarations.map(async ({ path, declaration }): Promise<PluginConfigPresentationSection> =>
			Object.freeze({
				path: Object.freeze([...path]),
				fieldName: declaration.fieldName,
				schema: declaration.schema,
				defaults: await collectConfigDefaults(declaration.schema, {
					missingObjectDefault: {},
				}),
			}),
		),
	)
	return {
		ok: true,
		plan: compileConfigPresentationPlanV1({
			fieldName: config.fieldName,
			schema: config.schema,
			defaults: await collectConfigDefaults(config.schema, { missingObjectDefault: {} }),
			sections,
		}),
	}
}

function configApplicationState(ctx: Context, owner: PluginNodeAddress) {
	const configService = requireConfigService(ctx)
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
): Promise<PluginConfigResult> {
	const configService = requireConfigService(ctx)
	const lookup = currentConfigLookup(ctx, owner)
	if (lookup.ok === false) return lookup
	return {
		ok: true,
		saved: false,
		...configApplicationState(ctx, owner),
		config: plainRecord(configService.getRawConfig(owner)),
		defaults: await collectConfigDefaults(lookup.config.schema, {
			missingObjectDefault: {},
		}),
	}
}

export async function pluginConfigValidate(
	ctx: Context,
	owner: PluginNodeAddress,
	patch: Record<string, unknown>,
): Promise<PluginConfigResult> {
	const configService = requireConfigService(ctx)
	const lookup = currentConfigLookup(ctx, owner)
	if (lookup.ok === false) return lookup
	const current = plainRecord(configService.getRawConfig(owner))
	const candidate = { ...current, ...patch }
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
		defaults,
	}
}

async function applyDesiredConfig(
	ctx: Context,
	owner: PluginNodeAddress,
	session: RuntimePluginGraphExclusiveSession<CommitSummary>,
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
		return { application: 'deferred', report: projectPluginApplyReport(ctx, session.report()) }
	}
	const notification = await notifyRunningPluginConfigUpdate(
		requirePluginService(ctx),
		owner,
		desired,
		desiredRevision,
	)
	const projected = projectPluginApplyReport(ctx, session.report())
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
	buildCandidate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<PluginConfigResult> {
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	return await coordinator.runExclusive(reason, async (session) => {
		const configService = requireConfigService(ctx)
		const lookup = configLookup(
			coordinator.catalogSnapshot(),
			session.runtimeStateSnapshot(),
			owner,
		)
		if (lookup.ok === false) return lookup
		const current = plainRecord(configService.getRawConfig(owner))
		const expectedRevision = configService.getConfigRevision(owner)
		const candidate = buildCandidate(current)
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
			staged = configService.stageValidatedConfig({
				owner,
				authority: lookup.config,
				expectedRevision,
				value: validation.output,
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
		}
	})
}

export async function pluginConfigPatch(
	ctx: Context,
	owner: PluginNodeAddress,
	patch: Record<string, unknown>,
): Promise<PluginConfigResult> {
	return await mutatePluginConfig(ctx, owner, 'plugin-config-patch', (current) => ({
		...current,
		...patch,
	}))
}

export async function pluginConfigPatchField(
	ctx: Context,
	owner: PluginNodeAddress,
	input: unknown,
): Promise<PluginConfigResult> {
	const parsed = parseConfigFieldMutation(input)
	if (parsed.ok === false) {
		return {
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
			message: parsed.message,
		}
	}
	return await mutatePluginConfig(ctx, owner, 'plugin-config-patch-field', (current) =>
		writeNestedField(current, parsed.segments, parsed.value),
	)
}

function parseConfigFieldMutation(
	input: unknown,
):
	| Readonly<{ ok: true; segments: readonly string[]; value: unknown }>
	| Readonly<{ ok: false; message: string }> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, message: 'Config field mutation must be an object.' }
	}
	const record = input as Record<string, unknown>
	if (typeof record.fieldPath !== 'string') {
		return { ok: false, message: 'fieldPath is required.' }
	}
	try {
		return {
			ok: true,
			segments: parseConfigFieldPathSegments(record.fieldPath),
			value: record.value,
		}
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : 'Invalid fieldPath.' }
	}
}

export async function pluginConfigReset(
	ctx: Context,
	owner: PluginNodeAddress,
	keys?: string[],
): Promise<PluginConfigResult> {
	return await mutatePluginConfig(ctx, owner, 'plugin-config-reset', (current) => {
		const candidate = { ...current }
		for (const key of keys?.length ? keys : Object.keys(candidate)) delete candidate[key]
		return candidate
	})
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
