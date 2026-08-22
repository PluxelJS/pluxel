import { BasePlugin } from '../../composition/BasePlugin'
import type { PluginToken, SubclassOf } from '../../types'
import { registerPluginMarker } from './marker'
import type { PluginOptions } from './types'

function validateOptions(input: PluginOptions | undefined): PluginOptions {
	if (input === undefined) return Object.freeze({})
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[pluxel/core] @Plugin options must be an object')
	}
	for (const key of Object.keys(input)) {
		if (key !== 'displayName' && key !== 'startTimeoutMs' && key !== 'forkable') {
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
	const forkable = input.forkable
	if (forkable !== undefined && forkable !== true) {
		throw new TypeError('[pluxel/core] @Plugin forkable must be the literal true')
	}
	return Object.freeze({
		...(displayName === undefined ? {} : { displayName }),
		...(startTimeoutMs === undefined ? {} : { startTimeoutMs }),
		...(forkable === undefined ? {} : { forkable }),
	})
}

function isBasePluginSubclass(value: unknown): value is PluginToken {
	return (
		typeof value === 'function' &&
		(value === BasePlugin || BasePlugin.prototype.isPrototypeOf((value as Function).prototype))
	)
}

export function Plugin(options?: PluginOptions): ClassDecorator
export function Plugin<B extends PluginToken>(
	provider: B,
	options?: PluginOptions,
): <C extends SubclassOf<B>>(ctor: C) => void
export function Plugin(a?: PluginOptions | PluginToken, b?: PluginOptions) {
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
		registerPluginMarker(
			ctor,
			Object.freeze({ options, ...(provider === undefined ? {} : { providerClass: provider }) }),
		)
	}
}
