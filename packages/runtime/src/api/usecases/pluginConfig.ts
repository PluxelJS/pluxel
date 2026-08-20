import { type Context, type PluginNodeAddressSnapshot } from '@pluxel/core'
import {
	ConfigValidationError,
	collectConfigDefaults,
	validateConfigRecord,
} from '@pluxel/core/services'
import type { ConfigFieldMutation } from '../../web/protocol'
import { requireRouteCapability } from '../../runtime/capabilities'

export type PluginSchemaResult =
	| {
			ok: true
			fieldName: string
			schemaSource: string
			defaults: Record<string, unknown>
			sections: readonly PluginSchemaSection[]
	  }
	| { ok: false; code: string; message: string }

export type PluginSchemaSection = Readonly<{
	path: readonly string[]
	fieldName: string
	schemaSource: string
	defaults: Record<string, unknown>
}>

export type PluginConfigResult =
	| { ok: true; saved: boolean; config: Record<string, unknown>; defaults: Record<string, unknown> }
	| {
			ok: false
			code: string
			message: string
			errors?: unknown
			defaults?: Record<string, unknown>
	  }

function plainRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {}
}

function writeNestedField(
	source: Record<string, unknown>,
	path: string,
	value: unknown,
): Record<string, unknown> {
	const segments = path
		.split('.')
		.map((segment) => segment.trim())
		.filter(Boolean)
	if (segments.length === 0) return source
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

function configDefinition(ctx: Context, owner: PluginNodeAddressSnapshot) {
	return requireRouteCapability(ctx, 'configMetadata').getConfig(owner)
}

function ownerSlot(ctx: Context, owner: PluginNodeAddressSnapshot) {
	return ctx.registry.internNodeAddress(owner)
}

export async function pluginSchema(
	ctx: Context,
	owner: PluginNodeAddressSnapshot,
): Promise<PluginSchemaResult> {
	const config = configDefinition(ctx, owner)
	if (!config)
		return {
			ok: false,
			code: 'schema_not_found',
			message: 'No config schema registered for this Plugin node.',
		}
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
	owner: PluginNodeAddressSnapshot,
): Promise<PluginConfigResult> {
	const config = configDefinition(ctx, owner)
	const defaults = config
		? await collectConfigDefaults(config.schema, { missingObjectDefault: {} })
		: {}
	return {
		ok: true,
		saved: false,
		config: plainRecord(ctx.configService.getRawConfig(ownerSlot(ctx, owner))),
		defaults,
	}
}

export async function pluginConfigValidate(
	ctx: Context,
	owner: PluginNodeAddressSnapshot,
	patch: Record<string, unknown>,
): Promise<PluginConfigResult> {
	const config = configDefinition(ctx, owner)
	if (!config)
		return {
			ok: false,
			code: 'config_not_found',
			message: 'No config schema registered for this Plugin node.',
		}
	const slot = ownerSlot(ctx, owner)
	const current = plainRecord(ctx.configService.getRawConfig(slot))
	const candidate = { ...current, ...patch }
	const [defaults, validation] = await Promise.all([
		collectConfigDefaults(config.schema, { missingObjectDefault: {} }),
		validateConfigRecord(config.schema, candidate),
	])
	if (validation.ok === false) {
		return {
			ok: false,
			code: 'validation_failed',
			message: 'Validation failed',
			errors: validation.errors,
			defaults,
		}
	}
	return { ok: true, saved: false, config: validation.output, defaults }
}

export async function pluginConfigPatch(
	ctx: Context,
	owner: PluginNodeAddressSnapshot,
	patch: Record<string, unknown>,
): Promise<PluginConfigResult> {
	const validation = await pluginConfigValidate(ctx, owner, patch)
	if (!validation.ok) return validation
	const config = configDefinition(ctx, owner)!
	const slot = ownerSlot(ctx, owner)
	const current = plainRecord(ctx.configService.getRawConfig(slot))
	ctx.configService.batch(() => {
		ctx.configService.unsetConfigKeys(
			slot,
			Object.keys(current).filter((key) => !(key in validation.config)),
		)
		ctx.configService.patchConfig(slot, validation.config)
	})
	try {
		await ctx.configService.ensureValidated(slot, config.schema, { missingObjectDefault: {} })
	} catch (error) {
		if (error instanceof ConfigValidationError) {
			return {
				ok: false,
				code: 'validation_failed',
				message: 'Validation failed',
				errors: error.errors,
				defaults: validation.defaults,
			}
		}
		throw error
	}
	return { ...validation, saved: true, config: plainRecord(ctx.configService.getRawConfig(slot)) }
}

export async function pluginConfigPatchField(
	ctx: Context,
	owner: PluginNodeAddressSnapshot,
	input: ConfigFieldMutation,
): Promise<PluginConfigResult> {
	const fieldPath = String(input.fieldPath ?? '').trim()
	if (!fieldPath) return { ok: false, code: 'validation_failed', message: 'fieldPath is required' }
	const current = plainRecord(ctx.configService.getRawConfig(ownerSlot(ctx, owner)))
	return await pluginConfigPatch(ctx, owner, writeNestedField(current, fieldPath, input.value))
}

export async function pluginConfigReset(
	ctx: Context,
	owner: PluginNodeAddressSnapshot,
	keys?: string[],
): Promise<PluginConfigResult> {
	const config = configDefinition(ctx, owner)
	if (!config)
		return {
			ok: false,
			code: 'config_not_found',
			message: 'No config schema registered for this Plugin node.',
		}
	const slot = ownerSlot(ctx, owner)
	const current = plainRecord(ctx.configService.getRawConfig(slot))
	ctx.configService.unsetConfigKeys(slot, keys?.length ? keys : Object.keys(current))
	const defaults = await collectConfigDefaults(config.schema, { missingObjectDefault: {} })
	try {
		await ctx.configService.ensureValidated(slot, config.schema, { missingObjectDefault: {} })
	} catch (error) {
		if (error instanceof ConfigValidationError) {
			return {
				ok: false,
				code: 'validation_failed',
				message: 'Validation failed',
				errors: error.errors,
				defaults,
			}
		}
		throw error
	}
	return {
		ok: true,
		saved: true,
		config: plainRecord(ctx.configService.getRawConfig(slot)),
		defaults,
	}
}
