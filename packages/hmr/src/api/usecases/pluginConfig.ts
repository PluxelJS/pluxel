import type { Context } from '@pluxel/core'
import {
	collectConfigDefaults,
	ConfigValidationError,
	validateConfigPatch,
} from '@pluxel/core/services'

export type PluginSchemaResult =
	| { ok: true; schemaSource: Readonly<Record<string, string>>; defaults: Record<string, unknown> }
	| { ok: false; code: string; message: string }

export type PluginConfigResult =
	| {
			ok: true
			saved: boolean
			config: Record<string, unknown>
			defaults: Record<string, unknown>
	  }
	| { ok: false; code: string; message: string; errors?: unknown; defaults?: Record<string, unknown> }

function normalizePlainObject(record: unknown): Record<string, unknown> {
	if (!record || typeof record !== 'object') return {}
	return Object.assign({}, record as Record<string, unknown>)
}

export async function pluginSchema(ctx: Context, name: string): Promise<PluginSchemaResult> {
	const schemaMap = ctx.loader.api.registry.getSchema(name)
	if (!schemaMap) {
		return { ok: false, code: 'schema_not_found', message: 'No config schema registered for this plugin.' }
	}

	const schemaSource = ctx.loader.api.registry.getSchemaSource(name)
	if (!schemaSource || Object.keys(schemaSource).length === 0) {
		return {
			ok: false,
			code: 'schema_source_missing',
			message:
				`Schema source not available for plugin "${name}". Ensure configSourcePlugin is configured and the plugin declares config via @Config(schema) or field = this.configs.use(schema).`,
		}
	}

	return {
		ok: true,
		schemaSource,
		defaults: await collectConfigDefaults(schemaMap, { missingObjectDefault: {} }),
	}
}

export async function pluginConfigGet(ctx: Context, name: string): Promise<PluginConfigResult> {
	const schema = ctx.loader.api.registry.getSchema(name)
	const defaults = schema ? await collectConfigDefaults(schema, { missingObjectDefault: {} }) : {}
	const rawConfig = ctx.configService.getRawConfig(name)
	return { ok: true, saved: false, config: normalizePlainObject(rawConfig), defaults }
}

export async function pluginConfigValidate(
	ctx: Context,
	name: string,
	patch: Record<string, unknown>,
): Promise<PluginConfigResult> {
	const schema = ctx.loader.api.registry.getSchema(name)
	if (!schema) return { ok: false, code: 'config_not_found', message: 'No config schema registered for this plugin.' }

	const [defaults, validation] = await Promise.all([
		collectConfigDefaults(schema, { missingObjectDefault: {} }),
		validateConfigPatch(schema, patch),
	])

	if (validation.ok === false) {
		return { ok: false, code: 'validation_failed', message: 'Validation failed', errors: validation.errors, defaults }
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
	const schema = ctx.loader.api.registry.getSchema(name)
	if (!schema) return { ok: false, code: 'config_not_found', message: 'No config schema registered for this plugin.' }

	const [defaults, validation] = await Promise.all([
		collectConfigDefaults(schema, { missingObjectDefault: {} }),
		validateConfigPatch(schema, patch),
	])

	if (validation.ok === false) {
		return { ok: false, code: 'validation_failed', message: 'Validation failed', errors: validation.errors, defaults }
	}

	if (Object.keys(validation.output).length > 0) {
		ctx.configService.patchConfig(name, validation.output)
	}

	try {
		await ctx.configService.ensureValidated(name, schema, { missingObjectDefault: {} })
	} catch (error) {
		if (error instanceof ConfigValidationError) {
			return { ok: false, code: 'validation_failed', message: 'Validation failed', errors: error.errors, defaults }
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

export async function pluginConfigReset(
	ctx: Context,
	name: string,
	keys?: string[],
): Promise<PluginConfigResult> {
	const schema = ctx.loader.api.registry.getSchema(name)
	if (!schema) return { ok: false, code: 'config_not_found', message: 'No config schema registered for this plugin.' }

	const targetKeys = Array.isArray(keys) && keys.length ? keys : Object.keys(schema)
	ctx.configService.unsetConfigKeys(name, targetKeys)

	const defaults = await collectConfigDefaults(schema, { missingObjectDefault: {} })
	try {
		await ctx.configService.ensureValidated(name, schema, { missingObjectDefault: {} })
	} catch (error) {
		if (error instanceof ConfigValidationError) {
			return { ok: false, code: 'validation_failed', message: 'Validation failed', errors: error.errors, defaults }
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
