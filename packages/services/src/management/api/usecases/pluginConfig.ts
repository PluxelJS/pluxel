import type { Context, PluginNodeAddress } from '@pluxel/core'
import { collectConfigDefaults } from '@pluxel/core/services'
import {
	type HostOperationOptions,
	lookupPluginConfig,
	mutatePluginConfig,
	pluginConfigGet as getConfig,
	pluginConfigValidate as validateConfig,
	pluginConfigPatch as patchConfig,
	pluginConfigReset as resetConfig,
	projectPluginApplyReport,
} from '@pluxel/host/internal'
import type { HostPluginConfigResult } from '@pluxel/host'
import type { ConfigPresentationResult, ConfigResult } from '../../web/protocol'
import { compileConfigPresentationPlanV1 } from '../presenters/configPresentation'
import { parseConfigFieldPathSegments } from '../../web/validation'

function projectConfigResult(ctx: Context, result: HostPluginConfigResult): ConfigResult {
	if (result.ok === false) return result
	if (result.saved === false) return result
	return { ...result, report: projectPluginApplyReport(ctx, result.report) }
}
export async function pluginConfigGet(
	ctx: Context,
	owner: PluginNodeAddress,
	options?: HostOperationOptions,
): Promise<ConfigResult> {
	return projectConfigResult(ctx, await getConfig(ctx, owner, options))
}
export async function pluginConfigValidate(
	ctx: Context,
	owner: PluginNodeAddress,
	patch: Record<string, unknown>,
	options?: HostOperationOptions,
): Promise<ConfigResult> {
	return projectConfigResult(ctx, await validateConfig(ctx, owner, patch, options))
}
export async function pluginConfigPatch(
	ctx: Context,
	owner: PluginNodeAddress,
	patch: Record<string, unknown>,
	options?: HostOperationOptions,
): Promise<ConfigResult> {
	return projectConfigResult(ctx, await patchConfig(ctx, owner, patch, options))
}
export async function pluginConfigReset(
	ctx: Context,
	owner: PluginNodeAddress,
	keys?: string[],
	options?: HostOperationOptions,
): Promise<ConfigResult> {
	return projectConfigResult(ctx, await resetConfig(ctx, owner, keys, options))
}

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

export async function pluginConfigPresentation(
	ctx: Context,
	owner: PluginNodeAddress,
	options?: HostOperationOptions,
): Promise<ConfigPresentationResult> {
	const lookup = await lookupPluginConfig(ctx, owner, options)
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
		declarations.map(async ({ path, declaration }) =>
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

export async function pluginConfigPatchField(
	ctx: Context,
	owner: PluginNodeAddress,
	input: unknown,
	options?: HostOperationOptions,
): Promise<ConfigResult> {
	const parsed = parseConfigFieldMutation(input)
	if (parsed.ok === false) {
		return {
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
			message: parsed.message,
		}
	}
	return projectConfigResult(
		ctx,
		await mutatePluginConfig(
			ctx,
			owner,
			'plugin-config-patch-field',
			(current) => writeNestedField(current, parsed.segments, parsed.value),
			options,
			[parsed.segments],
		),
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
