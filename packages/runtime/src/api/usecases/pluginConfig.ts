import { type CommitSummary, type Context, type PluginNodeAddress } from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import { collectConfigDefaults, validateConfigRecord } from '@pluxel/core/services'
import type { ConfigResult, PluginApplyReport, SchemaResult } from '../../web/protocol'
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

export type PluginSchemaResult = SchemaResult

export type PluginSchemaSection = Readonly<{
	path: readonly string[]
	fieldName: string
	schemaSource: string
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

export async function pluginSchema(
	ctx: Context,
	owner: PluginNodeAddress,
): Promise<PluginSchemaResult> {
	const lookup = currentConfigLookup(ctx, owner)
	if (lookup.ok === false) {
		return {
			ok: false,
			code: lookup.code === 'config_not_found' ? 'schema_not_found' : lookup.code,
			message: lookup.message,
		}
	}
	const config = lookup.config
	if (!config.source) {
		return {
			ok: false,
			code: 'schema_source_missing',
			message:
				'Schema source is unavailable. Ensure configSourcePlugin processes the single configs.use(ObjectSchema) declaration.',
		}
	}
	const declarations = [
		...(config.owner ? [{ path: Object.freeze([] as string[]), declaration: config.owner }] : []),
		...config.parts.flatMap((part) =>
			part.declaration ? [{ path: part.path, declaration: part.declaration }] : [],
		),
	]
	if (declarations.some((item) => item.declaration.source === undefined)) {
		return {
			ok: false,
			code: 'schema_source_missing',
			message:
				'Schema source is unavailable for a PluginPart. Ensure configSourcePlugin processes every configs.use(ObjectSchema) declaration.',
		}
	}
	const sections = await Promise.all(
		declarations.map(
			async ({ path, declaration }): Promise<PluginSchemaSection> =>
				Object.freeze({
					path: Object.freeze([...path]),
					fieldName: declaration.fieldName,
					schemaSource: declaration.source!,
					defaults: await collectConfigDefaults(declaration.schema, {
						missingObjectDefault: {},
					}),
				}),
		),
	)
	return {
		ok: true,
		fieldName: config.fieldName,
		schemaSource: config.source,
		defaults: await collectConfigDefaults(config.schema, { missingObjectDefault: {} }),
		sections: Object.freeze(sections),
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
		application: 'not-requested',
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
		application: 'not-requested',
		config: validation.output,
		defaults,
	}
}

async function applyDesiredConfig(
	ctx: Context,
	owner: PluginNodeAddress,
	session: RuntimePluginGraphExclusiveSession<CommitSummary>,
): Promise<
	| {
			application: 'applied' | 'deferred'
			report: PluginApplyReport
	  }
	| {
			application: 'saved-not-applied'
			report: PluginApplyReport
			applyFailure: {
				code: 'plugin_not_running_after_restart'
				message: string
			}
	  }
> {
	if (!requirePluginService(ctx).isRunning(owner)) {
		const report = await session.update({ reason: 'plugin-config-deferred', mode: 'live' })
		return { application: 'deferred', report: projectPluginApplyReport(ctx, report) }
	}
	const report = await session.update({
		reason: 'plugin-config-restart',
		restartNodes: [owner],
		mode: 'live',
	})
	const projected = projectPluginApplyReport(ctx, report)
	if (requirePluginService(ctx).isRunning(owner)) {
		return { application: 'applied', report: projected }
	}
	return {
		application: 'saved-not-applied',
		report: projected,
		applyFailure: {
			code: 'plugin_not_running_after_restart',
			message: 'Plugin restart did not return the node to running state.',
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
		configService.confirmValidatedConfig(staged)
		return {
			ok: true,
			saved: true,
			...(await applyDesiredConfig(ctx, owner, session)),
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
	const fieldPath = record.fieldPath.trim()
	if (!fieldPath || fieldPath.length > 512) {
		return { ok: false, message: 'fieldPath must contain between 1 and 512 characters.' }
	}
	const segments = fieldPath.split('.').map((segment) => segment.trim())
	if (segments.length > 32 || segments.some((segment) => !segment || segment.length > 128)) {
		return { ok: false, message: 'fieldPath contains an empty or oversized segment.' }
	}
	if (
		segments.some(
			(segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor',
		)
	) {
		return { ok: false, message: 'fieldPath contains a reserved segment.' }
	}
	return { ok: true, segments: Object.freeze(segments), value: record.value }
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
