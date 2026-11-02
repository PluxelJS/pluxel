import { pluginNodeIndexKey, type PluginConstructor } from '@pluxel/core'
import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { projectRawInput, type Schema } from 'valibot-form'
import type { HostOptions } from './host'

export class InputBindingError extends Error {
	constructor(
		readonly code: 'INVALID_BINDING' | 'MISSING_INPUT' | 'INVALID_INPUT' | 'FILE_READ_FAILED',
		message: string,
	) {
		super(message)
		this.name = 'InputBindingError'
	}
}

export type InputSchema = StandardSchemaV1 & { readonly kind: 'schema'; readonly type: string }
export const declaredConfigBindings = new WeakSet<object>()

export function fail(message: string): never {
	throw new InputBindingError('INVALID_BINDING', message)
}
export function record(value: unknown): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	)
}
export function schema(value: unknown, label: string): InputSchema {
	if (
		!record(value) ||
		value.kind !== 'schema' ||
		!record(value['~standard']) ||
		typeof value['~standard'].validate !== 'function'
	)
		fail(`[host] ${label} must declare a Valibot schema`)
	return value as unknown as InputSchema
}
export function configSchema(plugin: PluginConstructor, selected?: StandardSchemaV1): InputSchema {
	const candidate = consumePluginDefinitionCandidate(plugin)
	const declared = schema(candidate.declaration.config?.owner?.schema, 'configs.use()')
	if (selected !== undefined && declared !== selected)
		fail('[host] Config binding must reference the same schema as configs.use()')
	return declared
}
/** Recheck config deployment paths against replacement metadata. Vault contracts belong to the Host binding. */
export async function validateInputBindingCandidates(
	plugins: readonly PluginConstructor[],
	options: Pick<HostOptions, 'runtime'>,
): Promise<void> {
	for (const plugin of plugins) {
		const owner = pluginNodeIndexKey(plugin.nodeAddress())
		const overlays =
			options.runtime?.configRecords?.overlays?.filter(
				(entry) => declaredConfigBindings.has(entry) && pluginNodeIndexKey(entry.owner) === owner,
			) ?? []
		const files =
			options.runtime?.configRecords?.declarationSources?.filter(
				(entry) => declaredConfigBindings.has(entry) && pluginNodeIndexKey(entry.owner) === owner,
			) ?? []
		if (overlays.length > 0 || files.length > 0) {
			const declared = configSchema(plugin)
			for (const overlay of overlays)
				for (const source of overlay.sources) {
					if (!projectRawInput(declared as unknown as Schema, source.path).ok)
						fail('[host] Replacement config schema is incompatible with deployment bindings')
				}
		}
	}
}
