import { BasePlugin } from '../../composition/BasePlugin'
import type { PluginIdentifier, SubclassOf } from '../../types'
import type { PluginMarker, PluginOptions } from './types'

const markers = new WeakMap<Function, PluginMarker>()

function validateOptions(input: PluginOptions | undefined): PluginOptions {
	if (input === undefined) return Object.freeze({})
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[pluxel/core] @Plugin options must be an object')
	}
	for (const key of Object.keys(input)) {
		if (key !== 'displayName' && key !== 'startTimeoutMs') {
			throw new TypeError(`[pluxel/core] @Plugin options has unknown field ${key}`)
		}
	}
	const displayName = input.displayName
	if (
		displayName !== undefined &&
		(typeof displayName !== 'string' ||
			displayName.length === 0 ||
			displayName.trim() !== displayName)
	) {
		throw new TypeError('[pluxel/core] @Plugin displayName must be a non-empty string literal')
	}
	const startTimeoutMs = input.startTimeoutMs
	if (
		startTimeoutMs !== undefined &&
		(!Number.isFinite(startTimeoutMs) || !Number.isInteger(startTimeoutMs) || startTimeoutMs <= 0)
	) {
		throw new TypeError('[pluxel/core] @Plugin startTimeoutMs must be a positive finite integer')
	}
	return Object.freeze({
		...(displayName === undefined ? {} : { displayName }),
		...(startTimeoutMs === undefined ? {} : { startTimeoutMs }),
	})
}

function isBasePluginSubclass(value: unknown): value is PluginIdentifier {
	return (
		typeof value === 'function' &&
		(value === BasePlugin || BasePlugin.prototype.isPrototypeOf((value as Function).prototype))
	)
}

export function Plugin(options?: PluginOptions): ClassDecorator
export function Plugin<B extends PluginIdentifier>(
	provider: B,
	options?: PluginOptions,
): <C extends SubclassOf<B>>(ctor: C) => void
export function Plugin(a?: PluginOptions | PluginIdentifier, b?: PluginOptions) {
	const provider = typeof a === 'function' ? a : undefined
	const options = validateOptions(provider ? b : (a as PluginOptions | undefined))
	if (provider && !isBasePluginSubclass(provider)) {
		throw new TypeError('[pluxel/core] @Plugin abstract provider must extend BasePlugin')
	}
	return (ctor: Function) => {
		if (!isBasePluginSubclass(ctor)) {
			throw new TypeError('[pluxel/core] @Plugin target must extend BasePlugin')
		}
		if (provider && !provider.prototype.isPrototypeOf(ctor.prototype)) {
			throw new TypeError('[pluxel/core] @Plugin target must extend its abstract provider')
		}
		if (markers.has(ctor)) throw new Error('[pluxel/core] Plugin constructor is already decorated')
		markers.set(
			ctor,
			Object.freeze({ options, ...(provider === undefined ? {} : { providerClass: provider }) }),
		)
	}
}

export function getPluginMarker(ctor: Function): PluginMarker | undefined {
	return markers.get(ctor)
}

export function clonePluginMarker(from: Function, to: Function): void {
	const marker = markers.get(from)
	if (!marker) throw new Error('[pluxel/core] Cannot fork a constructor without @Plugin')
	markers.set(to, marker)
}
