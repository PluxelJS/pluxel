export const PLUGIN_LOWERING_ABI_VERSION = 2 as const

export type PluginLoweringHeader = Readonly<{
	readonly abiVersion: typeof PLUGIN_LOWERING_ABI_VERSION
}>

export type PluginLoweringErrorCode =
	| 'plugin_lowering_abi_unsupported'
	| 'plugin_declaration_missing'
	| 'plugin_declaration_invalid'

export class PluginLoweringError extends Error {
	readonly name = 'PluginLoweringError'

	constructor(
		readonly code: PluginLoweringErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

export function invalidPluginDeclaration(message: string, options?: ErrorOptions): never {
	throw new PluginLoweringError('plugin_declaration_invalid', message, options)
}

export function missingPluginDeclaration(message: string): never {
	throw new PluginLoweringError('plugin_declaration_missing', message)
}

export function parsePluginLoweringPayload(
	input: unknown,
	label: string,
	fields: readonly string[],
): Readonly<Record<string, unknown>> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		invalidPluginDeclaration(`[pluxel/core] ${label} must be an object`)
	}
	const record = input as Record<string, unknown>
	const allowed = new Set(['abiVersion', ...fields])
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) {
			invalidPluginDeclaration(`[pluxel/core] ${label} has unknown field ${key}`)
		}
	}
	const version = record.abiVersion
	if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
		invalidPluginDeclaration(`[pluxel/core] ${label}.abiVersion must be an integer`)
	}
	if (version !== PLUGIN_LOWERING_ABI_VERSION) {
		throw new PluginLoweringError(
			'plugin_lowering_abi_unsupported',
			`[pluxel/core] ${label} uses unsupported Plugin lowering ABI ${version}; expected ${PLUGIN_LOWERING_ABI_VERSION}`,
		)
	}
	return record
}

export function assertLoweringConstructor(
	value: unknown,
	label: string,
): asserts value is Function {
	if (typeof value !== 'function') {
		invalidPluginDeclaration(`[pluxel/core] ${label} must be a constructor`)
	}
}
