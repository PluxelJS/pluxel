import type { Context } from '../../context/Context'

export function pinContextValue(target: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		writable: false,
		enumerable: false,
		configurable: false,
	})
}

/** Copy the trusted generation projection onto an owner/caller prototype view. */
export function inheritPinnedPluginInfo(target: Context, source: Context): void {
	const descriptor = Reflect.getOwnPropertyDescriptor(source, 'pluginInfo')
	if (
		!descriptor ||
		!('value' in descriptor) ||
		descriptor.writable !== false ||
		descriptor.configurable !== false
	) {
		throw new TypeError('[pluxel/core] Source Context has no pinned Plugin generation info')
	}
	pinContextValue(target, 'pluginInfo', descriptor.value)
}
