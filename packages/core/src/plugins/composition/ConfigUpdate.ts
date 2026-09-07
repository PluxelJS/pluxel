import type { Context } from '../../context/Context'
import { enterOwnerInvocation } from '../../internal/owner-invocations'
import type { ConfigUpdateListener } from './PluginConfigs'

type ConfigRecord = Readonly<Record<string, unknown>>

type ConfigFieldBinding = {
	readonly target: Record<string, unknown>
	readonly fieldName: string
	readonly ctx: Context
	readonly path: readonly string[]
	readonly childKeys: ReadonlySet<string>
	current: ConfigRecord
	listener?: ConfigUpdateListener<Record<string, unknown>>
}

type ConfigGenerationBinding = {
	readonly fields: ConfigFieldBinding[]
}

type ConfigGenerationFrame = {
	readonly plugin: object
	readonly binding: ConfigGenerationBinding
	closed: boolean
}

export type PluginConfigNotificationResult =
	| Readonly<{ status: 'applied' }>
	| Readonly<{ status: 'listener_not_registered'; path: readonly string[] }>
	| Readonly<{ status: 'listener_failed'; path: readonly string[] }>
	| Readonly<{ status: 'generation_changed' }>

const fieldByValue = new WeakMap<object, ConfigFieldBinding>()
const generationByPlugin = new WeakMap<object, ConfigGenerationBinding>()
const generationFrames: ConfigGenerationFrame[] = []
const registrationWindows = new WeakSet<Context>()

export function openConfigUpdateRegistrationWindow(ctx: Context): void {
	registrationWindows.add(ctx)
}

export function closeConfigUpdateRegistrationWindow(ctx: Context): void {
	registrationWindows.delete(ctx)
}

export function registerPluginConfigUpdateListener<T extends object>(
	owner: Context,
	current: Readonly<T>,
	listener: ConfigUpdateListener<T>,
): void {
	if (!current || typeof current !== 'object' || Array.isArray(current)) {
		throw new TypeError('[pluxel/core] configs.onUpdate() requires an injected object config field')
	}
	if (typeof listener !== 'function') {
		throw new TypeError('[pluxel/core] configs.onUpdate() listener must be a function')
	}
	const binding = fieldByValue.get(current)
	if (!binding) {
		throw new TypeError(
			"[pluxel/core] configs.onUpdate() must receive this generation's injected config field",
		)
	}
	if (binding.ctx !== owner) {
		throw new Error(
			'[pluxel/core] configs.onUpdate() config field belongs to another Plugin/Part owner',
		)
	}
	if (!registrationWindows.has(owner)) {
		throw new Error('[pluxel/core] configs.onUpdate() is only available during the owner init()')
	}
	if (binding.listener) {
		throw new Error('[pluxel/core] configs.onUpdate() listener is already registered')
	}
	binding.listener = listener as ConfigUpdateListener<Record<string, unknown>>
}

export function beginPluginConfigGeneration(plugin: object): ConfigGenerationFrame {
	const frame: ConfigGenerationFrame = {
		plugin,
		binding: { fields: [] },
		closed: false,
	}
	generationFrames.push(frame)
	return frame
}

export function finishPluginConfigGeneration(frame: ConfigGenerationFrame): void {
	const active = generationFrames.pop()
	if (active !== frame || frame.closed) {
		generationFrames.length = 0
		throw new Error('[pluxel/core] Plugin config generation binding stack was corrupted')
	}
	frame.closed = true
	generationByPlugin.set(frame.plugin, frame.binding)
}

export function abortPluginConfigGeneration(frame: ConfigGenerationFrame): void {
	if (frame.closed) return
	const active = generationFrames.pop()
	frame.closed = true
	if (active === frame) return
	generationFrames.length = 0
	throw new Error('[pluxel/core] Plugin config generation binding stack was corrupted')
}

export function assignPluginConfigField(input: {
	target: object
	fieldName: string
	value: ConfigRecord
	ctx: Context
	path: readonly string[]
	childKeys: readonly string[]
}): void {
	const frame = generationFrames.at(-1)
	if (!frame || frame.closed) {
		throw new Error('[pluxel/core] Plugin config field assignment has no active generation binding')
	}
	const target = input.target as Record<string, unknown>
	target[input.fieldName] = input.value
	const binding: ConfigFieldBinding = {
		target,
		fieldName: input.fieldName,
		ctx: input.ctx,
		path: Object.freeze([...input.path]),
		childKeys: new Set(input.childKeys),
		current: input.value,
	}
	frame.binding.fields.push(binding)
	fieldByValue.set(input.value, binding)
}

export async function notifyPluginConfigGeneration(
	plugin: object,
	desired: ConfigRecord,
): Promise<PluginConfigNotificationResult> {
	const generation = generationByPlugin.get(plugin)
	if (!generation) {
		throw new Error('[pluxel/core] Running Plugin generation has no config binding')
	}
	const changed = generation.fields
		.map((field) => ({ field, desired: selectDeclarationSlice(desired, field) }))
		.filter(({ field, desired: next }) => !configValueEqual(field.current, next))

	if (changed.length === 0) {
		return Object.freeze({ status: 'applied' })
	}

	const missing = changed.find(({ field }) => field.listener === undefined)
	if (missing) {
		return Object.freeze({ status: 'listener_not_registered', path: missing.field.path })
	}

	for (const item of changed) {
		let lease
		try {
			lease = enterOwnerInvocation(item.field.ctx)
		} catch {
			return Object.freeze({ status: 'generation_changed' })
		}
		try {
			await item.field.listener!(
				Object.freeze({
					applied: item.field.current,
					desired: item.desired,
					signal: lease.signal,
				}),
			)
			if (lease.signal.aborted) return Object.freeze({ status: 'generation_changed' })
		} catch (error) {
			if (lease.signal.aborted) return Object.freeze({ status: 'generation_changed' })
			item.field.ctx.logger.error('Plugin config update listener failed', { error })
			return Object.freeze({ status: 'listener_failed', path: item.field.path })
		} finally {
			lease.dispose()
		}
	}

	for (const item of changed) publishConfigField(item.field, item.desired)
	return Object.freeze({ status: 'applied' })
}

function selectDeclarationSlice(
	composite: ConfigRecord,
	binding: ConfigFieldBinding,
): ConfigRecord {
	let value: unknown = composite
	for (const segment of binding.path) {
		value =
			value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined
	}
	const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	if (binding.childKeys.size === 0) return record as ConfigRecord
	const own: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(record)) {
		if (!binding.childKeys.has(key)) own[key] = item
	}
	return Object.freeze(own)
}

function publishConfigField(binding: ConfigFieldBinding, value: ConfigRecord): void {
	binding.target[binding.fieldName] = value
	binding.current = value
	fieldByValue.set(value, binding)
}

function configValueEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
		for (let index = 0; index < left.length; index++) {
			if (!configValueEqual(left[index], right[index])) return false
		}
		return true
	}
	const leftRecord = left as Record<string, unknown>
	const rightRecord = right as Record<string, unknown>
	const leftKeys = Object.keys(leftRecord)
	const rightKeys = Object.keys(rightRecord)
	if (leftKeys.length !== rightKeys.length) return false
	for (const key of leftKeys) {
		if (!Object.hasOwn(rightRecord, key) || !configValueEqual(leftRecord[key], rightRecord[key])) {
			return false
		}
	}
	return true
}
