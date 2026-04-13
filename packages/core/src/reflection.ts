import '@abraham/reflection'

// `@abraham/reflection` intentionally implements a small subset of `reflect-metadata`.
//
// Some downstream dependencies (or the `reflect-metadata` polyfill itself) may probe for
// `getOwnMetadataKeys()` / `deleteMetadata()` during provider detection and will crash if
// these functions are missing.
//
// We provide minimal implementations so:
// - importing `reflect-metadata` later does not crash
// - consumers can safely "upgrade" to full `reflect-metadata` by importing it early
//
// Notes:
// - This is a compatibility shim, not a full `reflect-metadata` reimplementation.
// - If you rely on full key enumeration/deletion semantics, import `reflect-metadata`
//   before any decorated classes are evaluated.
const r = Reflect as unknown as Record<string, any>

if (typeof r.metadata === 'function' && typeof r.getOwnMetadataKeys !== 'function') {
	type MetadataKey = string | symbol
	type PropertyKey = string | symbol | undefined

	const ownedKeys = new WeakMap<object, Map<PropertyKey, Set<MetadataKey>>>()

	const recordKey = (target: object, propertyKey: PropertyKey, key: MetadataKey) => {
		let byProp = ownedKeys.get(target)
		if (!byProp) {
			byProp = new Map()
			ownedKeys.set(target, byProp)
		}
		let set = byProp.get(propertyKey)
		if (!set) {
			set = new Set()
			byProp.set(propertyKey, set)
		}
		set.add(key)
	}

	const readOwnKeys = (target: object, propertyKey: PropertyKey): MetadataKey[] => {
		const byProp = ownedKeys.get(target)
		const set = byProp?.get(propertyKey)
		return set ? [...set] : []
	}

	// Track keys for metadata written via `Reflect.defineMetadata` and `Reflect.metadata(...)`.
	const prevDefineMetadata: unknown = r.defineMetadata
	if (typeof prevDefineMetadata === 'function') {
		r.defineMetadata = (
			metadataKey: MetadataKey,
			metadataValue: unknown,
			target: object,
			propertyKey?: any,
		) => {
			recordKey(target, propertyKey as PropertyKey, metadataKey)
			return prevDefineMetadata(metadataKey, metadataValue, target, propertyKey)
		}
	}

	const prevMetadata: unknown = r.metadata
	if (typeof prevMetadata === 'function') {
		r.metadata = (metadataKey: MetadataKey, metadataValue: unknown) => {
			const decorator = prevMetadata(metadataKey, metadataValue)
			return (target: object, propertyKey?: any) => {
				recordKey(target, propertyKey as PropertyKey, metadataKey)
				return decorator(target, propertyKey)
			}
		}
	}

	r.getOwnMetadataKeys = (target: object, propertyKey?: any): MetadataKey[] => {
		return readOwnKeys(target, propertyKey as PropertyKey)
	}

	r.getMetadataKeys = (target: object, propertyKey?: any): MetadataKey[] => {
		const out = new Set<MetadataKey>()
		let cur: any = target
		while (cur) {
			for (const k of readOwnKeys(cur, propertyKey as PropertyKey)) out.add(k)
			cur = Object.getPrototypeOf(cur)
		}
		return [...out]
	}

	r.deleteMetadata = (metadataKey: MetadataKey, target: object, propertyKey?: any): boolean => {
		const byProp = ownedKeys.get(target)
		const set = byProp?.get(propertyKey as PropertyKey)
		if (!set || !set.has(metadataKey)) return false
		set.delete(metadataKey)
		if (set.size === 0) byProp!.delete(propertyKey as PropertyKey)
		if (byProp!.size === 0) ownedKeys.delete(target)
		return true
	}
}
