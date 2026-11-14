import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { PluginControlError } from '../catalog'
import type { PluginTarget } from './control'

type Descriptor = Readonly<{
	format: 1
	contracts: Readonly<{ config: string | null; instance: string }>
}>

/** Snapshot target data before it enters an asynchronous Host queue. */
export function normalizePluginTarget(target: PluginTarget): Readonly<{
	node: PluginNodeAddress
	descriptor?: Descriptor
}> {
	if (!target || typeof target !== 'object') throw new TypeError('Expected a Plugin target')
	if ('variant' in target) return { node: parsePluginNodeAddress(target) }
	const source = target
	if (source.format !== 1)
		throw new PluginControlError('control_format_unsupported', 'Control format 1 is required')
	const definition = parsePluginDefinitionAddress(source.definition)
	const contracts = source.contracts
	if (
		!contracts ||
		(contracts.config !== null &&
			(typeof contracts.config !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(contracts.config))) ||
		typeof contracts.instance !== 'string' ||
		!/^sha256:[a-f0-9]{64}$/.test(contracts.instance)
	)
		throw new TypeError('Plugin descriptor contracts require SHA-256 digests')
	return Object.freeze({
		node: parsePluginNodeAddress({ definition, variant: 'default' }),
		descriptor: Object.freeze({ format: 1, contracts: Object.freeze({ ...contracts }) }),
	})
}
