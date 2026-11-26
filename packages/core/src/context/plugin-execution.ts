import { pluginNodeIndexKey, type PluginNodeAddress } from '../plugins/runtime/identity'

/** Host-wide lifecycle timing and concurrency. */
export type CoreExecutionConfig = Readonly<{
	startTimeoutMs?: number
	drainTimeoutMs?: number
	startConcurrency?: number
	stopConcurrency?: number
}>

export const DEFAULT_PLUGIN_EXECUTION = Object.freeze({
	startTimeoutMs: 1500,
	drainTimeoutMs: 3000,
	startConcurrency: 8,
	stopConcurrency: 1,
})

const MAX_TIMEOUT_MS = 2_147_483_647

/** Shared by runtime validation and static decorator lowering. */
export function isStartTimeoutMs(value: unknown): value is number {
	return (
		typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS
	)
}

export function assertStartTimeoutMs(value: unknown, label: string): asserts value is number {
	if (!isStartTimeoutMs(value))
		throw new TypeError(`${label} must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
}

export type ResolvedCoreExecutionConfig = Required<CoreExecutionConfig> &
	Readonly<{ readNodeStartTimeout?: (address: PluginNodeAddress) => number | undefined }>

function resolveExecution(config: CoreExecutionConfig): Required<CoreExecutionConfig> {
	if (!config || typeof config !== 'object' || Array.isArray(config))
		throw new TypeError('[core] execution must be an object')
	const resolved: Record<keyof CoreExecutionConfig, number> = { ...DEFAULT_PLUGIN_EXECUTION }
	for (const key of Reflect.ownKeys(config)) {
		if (!Object.hasOwn(DEFAULT_PLUGIN_EXECUTION, key))
			throw new TypeError(`[core] execution includes unsupported ${String(key)}`)
		const field = key as keyof CoreExecutionConfig
		const descriptor = Object.getOwnPropertyDescriptor(config, field)!
		if (!descriptor.enumerable || !('value' in descriptor))
			throw new TypeError('[core] execution must contain only enumerable data fields')
		const value = config[field]
		if (value === undefined) continue
		const label = `[core] execution.${field}`
		if (field === 'startTimeoutMs' || field === 'drainTimeoutMs') {
			assertStartTimeoutMs(value, label)
		} else if (!Number.isSafeInteger(value) || value < 1) {
			throw new TypeError(`${label} must be a positive safe integer`)
		}
		resolved[field] = value
	}
	return resolved
}

const bindingIdentity: unique symbol = Symbol('CorePluginExecutionBinding')

/** @internal One preparation phase supplies the fixed execution values before service acquisition. */
export interface CorePluginExecutionBinding {
	readonly [bindingIdentity]: true
	read(): ResolvedCoreExecutionConfig
	bind(config: CoreExecutionConfig): void
}

export function createCorePluginExecutionBinding(
	nodeStartTimeoutMs?: ReadonlyMap<string, number>,
): CorePluginExecutionBinding {
	const timeouts = nodeStartTimeoutMs?.size ? new Map(nodeStartTimeoutMs) : undefined
	for (const timeout of timeouts?.values() ?? [])
		assertStartTimeoutMs(timeout, '[core] node startTimeoutMs')
	let values: ResolvedCoreExecutionConfig | undefined
	return Object.freeze({
		[bindingIdentity]: true as const,
		read() {
			if (!values) throw new Error('[core] Plugin execution policy has not been bound')
			return values
		},
		bind(config: CoreExecutionConfig) {
			if (values) throw new Error('[core] Plugin execution policy is already bound')
			values = Object.freeze({
				...resolveExecution(config),
				...(timeouts && {
					readNodeStartTimeout: (address: PluginNodeAddress) =>
						timeouts.get(pluginNodeIndexKey(address)),
				}),
			})
		},
	})
}

export function assertCorePluginExecutionBinding(value: CorePluginExecutionBinding): void {
	if (!value || value[bindingIdentity] !== true)
		throw new TypeError('[core] Invalid Plugin execution binding')
}
