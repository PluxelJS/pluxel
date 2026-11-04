import { type Context, type PluginNodeAddress } from '@pluxel/core'
import {
	type HostOperationOptions,
	lookupPluginConfig,
	pluginConfigGet as getConfig,
	pluginConfigValidate as validateConfig,
	pluginConfigPatch as patchConfig,
	pluginConfigReset as resetConfig,
	projectPluginApplyReport,
} from '@pluxel/host/internal'
import { type HostConfigMutation, type HostPluginConfigResult } from '@pluxel/host'
import { type ConfigPresentationResult, type ConfigResult } from '../../web/protocol'
import { compileConfigPresentationPlanV2 } from '../presenters/configPresentation'
import { parseConfigFieldPathSegments } from '../../web/validation'

function projectConfigResult(ctx: Context, result: HostPluginConfigResult): ConfigResult {
	if (result.ok === false) return result
	const { report, ...snapshot } = result
	return { ...snapshot, ...(report ? { report: projectPluginApplyReport(ctx, report) } : {}) }
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
	patch: HostConfigMutation,
	options?: HostOperationOptions,
): Promise<ConfigResult> {
	return projectConfigResult(ctx, await validateConfig(ctx, owner, patch, options))
}
export async function pluginConfigPatch(
	ctx: Context,
	owner: PluginNodeAddress,
	patch: HostConfigMutation,
	options?: HostOperationOptions,
): Promise<ConfigResult> {
	return projectConfigResult(ctx, await patchConfig(ctx, owner, patch, options))
}
export async function pluginConfigReset(
	ctx: Context,
	owner: PluginNodeAddress,
	paths?: readonly (readonly string[])[],
	options?: HostOperationOptions,
): Promise<ConfigResult> {
	return projectConfigResult(ctx, await resetConfig(ctx, owner, paths, options))
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
	const sections = declarations.map(({ path, declaration }) =>
		Object.freeze({
			path: Object.freeze([...path]),
			fieldName: declaration.fieldName,
			schema: declaration.schema,
		}),
	)
	return {
		ok: true,
		plan: compileConfigPresentationPlanV2({
			fieldName: config.fieldName,
			schema: config.schema,
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
		await patchConfig(
			ctx,
			owner,
			{
				remove: [parsed.segments],
				set: writeNestedField({}, parsed.segments, parsed.value),
			},
			options,
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
	if (
		!Object.hasOwn(record, 'value') ||
		Object.keys(record).some((key) => key !== 'fieldPath' && key !== 'value')
	) {
		return { ok: false, message: 'Config field mutation requires only fieldPath and value.' }
	}
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
