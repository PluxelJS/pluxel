import { InputBindingError } from './bindings'
import {
	pluginDefinitionAddressEqual,
	parsePluginNodeAddress,
	type PluginNodeAddress,
	type PluginConstructor,
} from '@pluxel/core'
import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { projectRawInput, type Schema } from 'valibot-form'
import type { ResolvedHostOptions } from './node-declarations'
import { configProvenance, type ConfigBindingProof } from './config-records'
const checkedBindings = new WeakSet<ConfigBindingProof>()

export type InputSchema = StandardSchemaV1 & { readonly kind: 'schema'; readonly type: string }

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
export function configSchema(
	target: PluginNodeAddress,
	selected?: StandardSchemaV1,
	plugins: readonly PluginConstructor[] = [],
): InputSchema {
	const owner = parsePluginNodeAddress(target)
	const plugin = plugins.find((candidate) =>
		pluginDefinitionAddressEqual(candidate.address(), owner.definition),
	)
	if (!plugin) return schema(selected, 'Config binding schema')
	const candidate = consumePluginDefinitionCandidate(plugin)
	const declared = schema(candidate.declaration.config?.owner?.schema, 'configs.use()')
	if (selected !== undefined && declared !== selected)
		fail('[host] Config binding must reference the same schema as configs.use()')
	return declared
}
export function configBindingProof(
	target: PluginNodeAddress,
	selected: StandardSchemaV1,
	paths: readonly (readonly string[])[],
	plugins: readonly PluginConstructor[],
): ConfigBindingProof {
	const owner = parsePluginNodeAddress(target)
	const proof = Object.freeze({
		owner,
		schema: selected,
		paths: Object.freeze(paths.map((path) => Object.freeze([...path]))),
	})
	if (plugins.some((plugin) => pluginDefinitionAddressEqual(plugin.address(), owner.definition)))
		checkedBindings.add(proof)
	return proof
}
/** Deployment paths are checked against the actual replacement definition, including every fork. */
export async function validateInputBindingCandidates(
	plugins: readonly PluginConstructor[],
	options: Pick<ResolvedHostOptions, 'config'>,
): Promise<void> {
	const declaredBindings = configProvenance(options.config).bindings
	if (declaredBindings.length === 0) return
	for (const plugin of plugins) {
		const bindings = declaredBindings.filter((binding) =>
			pluginDefinitionAddressEqual(plugin.nodeAddress().definition, binding.owner.definition),
		)
		if (bindings.length === 0) continue
		const declared = configSchema(plugin.nodeAddress(), undefined, [plugin])
		for (const binding of bindings) {
			if (!checkedBindings.has(binding) && binding.schema !== declared)
				fail('[host] Config binding must reference the same schema as configs.use()')
			checkedBindings.add(binding)
			for (const path of binding.paths) {
				if (!projectRawInput(declared as unknown as Schema, path).ok)
					fail('[host] Replacement config schema is incompatible with deployment bindings')
			}
		}
	}
}
