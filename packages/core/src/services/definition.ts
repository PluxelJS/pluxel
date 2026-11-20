import {
	bindServiceIdentity,
	createServiceReference as createKernelServiceReference,
	createServiceRef as createKernelServiceRef,
	getServiceDefinitionAccess,
	isServiceRef,
} from '@pluxel/context/internal'
import type { ServiceAccess, ServiceClass, ServiceDefinition, ServiceRef } from '@pluxel/context'
import {
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '../plugins/runtime/identity'

export type ServiceDefinitionAddress = PluginDefinitionAddress
export type ServiceDefinitionLoweringPayload = Readonly<{
	format: 1
	definition: ServiceDefinitionAddress
}>
export type ServiceRefLoweringPayload = ServiceDefinitionLoweringPayload &
	Readonly<{ access?: ServiceAccess; contract?: string }>
export type ServiceDefinitionMetadata = Readonly<{
	definition?: ServiceDefinitionAddress
	access: ServiceAccess
	contract?: string
	optional: boolean
}>
const records = new WeakMap<
	object,
	Readonly<{ definition: ServiceDefinitionAddress; contract?: string }>
>()

/** Optional service reference. The semantic compiler resolves T before TypeScript erases it. */
export function defineServiceRef<T>(): ServiceRef<T> {
	throw new TypeError(
		'[pluxel/core] Service ref was not lowered. defineServiceRef<T>() must be processed by the Pluxel semantic pass.',
	)
}
export function __defineServiceDefinition<C extends ServiceClass<any, ServiceAccess>>(
	service: C,
	input: ServiceDefinitionLoweringPayload,
): C {
	const definition = address(input)
	bindServiceIdentity(service, pluginDefinitionIndexKey(definition))
	const previous = records.get(service)
	if (
		previous &&
		pluginDefinitionIndexKey(previous.definition) !== pluginDefinitionIndexKey(definition)
	)
		throw new TypeError('[pluxel/core] Service declaration has multiple authoritative definitions')
	records.set(
		service,
		Object.freeze({ definition, ...(previous?.contract ? { contract: previous.contract } : {}) }),
	)
	return service
}
export function __defineServiceRef<T, A extends ServiceAccess = ServiceAccess>(
	input: ServiceRefLoweringPayload,
): ServiceRef<T, A> {
	const definition = address(input)
	if (input.contract !== undefined) assertContract(input.contract)
	const ref = createKernelServiceRef<T, A>(
		pluginDefinitionIndexKey(definition),
		(input.access ?? 'all') as A,
	)
	records.set(
		ref,
		Object.freeze({ definition, ...(input.contract ? { contract: input.contract } : {}) }),
	)
	return ref
}
/** Required, typed reference for verified control materials; this never loads a service implementation. */
export function createServiceReference<T, A extends ServiceAccess = ServiceAccess>(
	input: Readonly<{ definition: ServiceDefinitionAddress; access: A; contract?: string }>,
): ServiceDefinition<T, A> {
	const definition = parsePluginDefinitionAddress(input.definition)
	if (input.contract !== undefined) assertContract(input.contract)
	const ref = createKernelServiceReference<T, A>(pluginDefinitionIndexKey(definition), input.access)
	records.set(
		ref,
		Object.freeze({ definition, ...(input.contract ? { contract: input.contract } : {}) }),
	)
	return ref
}
/** Read original evidence only; copying or asserting a reference cannot recreate it. */
export function readServiceDefinition(
	target: ServiceDefinition<any, ServiceAccess> | ServiceRef<any>,
): ServiceDefinitionMetadata {
	const access = getServiceDefinitionAccess(target)
	const record = records.get(target)
	return Object.freeze({ ...record, access, optional: isServiceRef(target) })
}
/** Host acceptance associates a generated declaration contract with its native installed declaration. */
export function setServiceControlContract(
	target: ServiceDefinition<any, ServiceAccess>,
	contract: string,
): void {
	assertContract(contract)
	const record = records.get(target)
	if (!record)
		throw new TypeError(
			'[pluxel/core] Cannot bind a control contract to an unlowered service declaration',
		)
	records.set(target, Object.freeze({ definition: record.definition, contract }))
}
function address(input: ServiceDefinitionLoweringPayload): ServiceDefinitionAddress {
	if (!input || input.format !== 1)
		throw new TypeError('[pluxel/core] Unsupported service lowering format')
	return parsePluginDefinitionAddress(input.definition)
}
function assertContract(value: string): void {
	if (!/^sha256:[a-f0-9]{64}$/.test(value))
		throw new TypeError('[pluxel/core] Invalid service control contract')
}
