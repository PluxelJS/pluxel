import { type Context, getPluginInfo } from '@pluxel/core'
import {
	ConfigValidationError,
	collectConfigDefaults,
	validateConfigPatch,
} from '@pluxel/core/services'
import type { BuiltinMarkdownPart } from '../../management/document-contracts'
import type { ConfigFieldMutation } from '../../web/protocol'
import { requireRouteCapability } from '../../runtime/capabilities'

export type PluginSchemaResult =
	| {
			ok: true
			schemaSource: Readonly<Record<string, string>>
			defaults: Record<string, unknown>
			layout?: BuiltinMarkdownPart[] | null
	  }
	| { ok: false; code: string; message: string }

export type PluginConfigResult =
	| {
			ok: true
			saved: boolean
			config: Record<string, unknown>
			defaults: Record<string, unknown>
	  }
	| {
			ok: false
			code: string
			message: string
			errors?: unknown
			defaults?: Record<string, unknown>
	  }

function normalizePlainObject(record: unknown): Record<string, unknown> {
	if (!record || typeof record !== 'object') return {}
	return Object.assign({}, record as Record<string, unknown>)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
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

	const out: Record<string, unknown> = { ...source }
	let cursor: Record<string, unknown> = out
	for (let i = 0; i < segments.length - 1; i += 1) {
		const key = segments[i]!
		const next =
			cursor[key] && typeof cursor[key] === 'object' && !Array.isArray(cursor[key])
				? { ...(cursor[key] as Record<string, unknown>) }
				: {}
		cursor[key] = next
		cursor = next
	}
	cursor[segments.at(-1)!] = value
	return out
}

export async function pluginSchema(ctx: Context, name: string): Promise<PluginSchemaResult> {
	const configMetadata = requireRouteCapability(ctx, 'configMetadata')
	const catalog = requireRouteCapability(ctx, 'catalog')
	const schemaMap = configMetadata.getSchema(name)
	if (!schemaMap) {
		return {
			ok: false,
			code: 'schema_not_found',
			message: 'No config schema registered for this plugin.',
		}
	}

	const schemaSource = configMetadata.getSchemaSource(name)
	if (!schemaSource || Object.keys(schemaSource).length === 0) {
		return {
			ok: false,
			code: 'schema_source_missing',
			message: `Schema source not available for plugin "${name}". Ensure configSourcePlugin is configured and the plugin declares config via @Config(schema) or class-field config declaration (field = this.configs.use(schema) / field = this.configs.use(cfg(schemaMap))).`,
		}
	}

	const layoutMap = configMetadata.getConfigLayout(name) ?? null
	let layout: BuiltinMarkdownPart[] | null = null
	if (layoutMap && Object.keys(layoutMap).length > 0) {
		const ctor = catalog.resolveOrRegistered(name)
		// Prefer the layout attached to the cfg-binding that covers all schema keys.
		// Fallback to deterministic first entry.
		const bindingsMap = ctor ? getPluginInfo(ctor).configBindingsMap : null

		const schemaKeys = Object.keys(schemaMap ?? {})
		const coversAll = (field: string): boolean => {
			if (!bindingsMap) return false
			const list = bindingsMap[field]
			if (!Array.isArray(list)) return false
			const set = new Set(list.map(String))
			return schemaKeys.every((k) => set.has(k))
		}

		const entries = Object.entries(layoutMap).filter(([, v]) => Array.isArray(v) && v.length > 0)
		const preferred = entries.find(([field]) => coversAll(field))
		if (preferred) layout = preferred[1] as any
		else {
			entries.sort((a, b) => a[0].localeCompare(b[0]))
			layout = (entries[0]?.[1] as any) ?? null
		}
	}

	return {
		ok: true,
		schemaSource,
		defaults: await collectConfigDefaults(schemaMap, { missingObjectDefault: {} }),
		layout,
	}
}

export async function pluginConfigGet(ctx: Context, name: string): Promise<PluginConfigResult> {
	const schema = requireRouteCapability(ctx, 'configMetadata').getSchema(name)
	const defaults = schema ? await collectConfigDefaults(schema, { missingObjectDefault: {} }) : {}
	const rawConfig = ctx.configService.getRawConfig(name)
	return { ok: true, saved: false, config: normalizePlainObject(rawConfig), defaults }
}

export async function pluginConfigValidate(
	ctx: Context,
	name: string,
	patch: Record<string, unknown>,
): Promise<PluginConfigResult> {
	const schema = requireRouteCapability(ctx, 'configMetadata').getSchema(name)
	if (!schema)
		return {
			ok: false,
			code: 'config_not_found',
			message: 'No config schema registered for this plugin.',
		}

	const [defaults, validation] = await Promise.all([
		collectConfigDefaults(schema, { missingObjectDefault: {} }),
		validateConfigPatch(schema, patch),
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

	return {
		ok: true,
		saved: false,
		config: { ...normalizePlainObject(ctx.configService.getRawConfig(name)), ...validation.output },
		defaults,
	}
}

export async function pluginConfigPatch(
	ctx: Context,
	name: string,
	patch: Record<string, unknown>,
): Promise<PluginConfigResult> {
	const schema = requireRouteCapability(ctx, 'configMetadata').getSchema(name)
	if (!schema)
		return {
			ok: false,
			code: 'config_not_found',
			message: 'No config schema registered for this plugin.',
		}

	const [defaults, validation] = await Promise.all([
		collectConfigDefaults(schema, { missingObjectDefault: {} }),
		validateConfigPatch(schema, patch),
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

	if (Object.keys(validation.output).length > 0) {
		ctx.configService.patchConfig(name, validation.output)
	}

	try {
		await ctx.configService.ensureValidated(name, schema, { missingObjectDefault: {} })
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
		config: normalizePlainObject(ctx.configService.getRawConfig(name)),
		defaults,
	}
}

export async function pluginConfigPatchField(
	ctx: Context,
	name: string,
	input: ConfigFieldMutation,
): Promise<PluginConfigResult> {
	const schemaKey = String(input.schemaKey ?? '').trim()
	const fieldPath = String(input.fieldPath ?? '').trim()
	if (!schemaKey || !fieldPath) {
		return {
			ok: false,
			code: 'validation_failed',
			message: 'schemaKey and fieldPath are required',
		}
	}

	const current = normalizePlainObject(ctx.configService.getRawConfig(name))
	const currentSchemaValue = isPlainObject(current[schemaKey])
		? (current[schemaKey] as Record<string, unknown>)
		: {}
	const nextSchemaValue = writeNestedField(currentSchemaValue, fieldPath, input.value)
	return await pluginConfigPatch(ctx, name, {
		[schemaKey]: nextSchemaValue,
	})
}

export async function pluginConfigReset(
	ctx: Context,
	name: string,
	keys?: string[],
): Promise<PluginConfigResult> {
	const schema = requireRouteCapability(ctx, 'configMetadata').getSchema(name)
	if (!schema)
		return {
			ok: false,
			code: 'config_not_found',
			message: 'No config schema registered for this plugin.',
		}

	const targetKeys = Array.isArray(keys) && keys.length > 0 ? keys : Object.keys(schema)
	ctx.configService.unsetConfigKeys(name, targetKeys)

	const defaults = await collectConfigDefaults(schema, { missingObjectDefault: {} })
	try {
		await ctx.configService.ensureValidated(name, schema, { missingObjectDefault: {} })
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
		config: normalizePlainObject(ctx.configService.getRawConfig(name)),
		defaults,
	}
}
