import { createHash } from 'node:crypto'
import type { Font, FontDetails, FontLoader, Renderer } from '@takumi-rs/core'

// One ABI per worker realm; independently bundled templates share only native resources.
const CACHE = Symbol.for('@pluxel/plugin-takumi/renderer-cache/v1')
const MAX_RENDERERS = 4
const MAX_FONT_BYTES = 64 * 1024 * 1024
const RESOURCE_CACHE_BYTES = 16 * 1024 * 1024

type Constructor = typeof Renderer
type Entry = { renderer: Renderer; fonts: FontLoader[]; fontBytes: number }
type Pool = { entries: Map<string, Entry>; fontBytes: number }
type Registry = WeakMap<Constructor, Pool>

/** Internal: cache identity includes ordered font contents and every font metadata field. */
export function getWorkerRenderer(Backend: Constructor, fonts: readonly Font[] = []): Entry {
	const scope = globalThis as typeof globalThis & { [CACHE]?: Registry }
	const registry = (scope[CACHE] ??= new WeakMap())
	let pool = registry.get(Backend)
	if (!pool) {
		pool = { entries: new Map(), fontBytes: 0 }
		registry.set(Backend, pool)
	}
	const hash = createHash('sha256')
	const loaders: FontLoader[] = []
	let fontBytes = 0
	const retained: {
		key: string
		descriptor: Omit<FontDetails, 'data'>
		bytes: Uint8Array
	}[] = []
	for (const font of fonts) {
		const descriptor =
			font instanceof ArrayBuffer || ArrayBuffer.isView(font) ? { data: font } : font
		const { data, name, weight, style, subsetOf, subsetRank, generic } = descriptor
		if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array))
			throw new TypeError('Worker fonts require concrete ArrayBuffer or Uint8Array data')
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
		const key = createHash('sha256')
			.update(JSON.stringify([name, weight, style, subsetOf, subsetRank, generic]))
			.update(bytes)
			.digest('hex')
		hash.update(key)
		fontBytes += bytes.byteLength
		retained.push({
			key,
			descriptor: { name, weight, style, subsetOf, subsetRank, generic },
			bytes,
		})
	}
	const key = hash.digest('hex')
	const cached = pool.entries.get(key)
	if (cached) {
		pool.entries.delete(key)
		pool.entries.set(key, cached)
		return cached
	}
	for (const { key: fontKey, descriptor, bytes } of retained) {
		// A warm entry owns its bytes; a caller may reuse its original after render settles.
		const owned = fontBytes <= MAX_FONT_BYTES ? new Uint8Array(bytes) : bytes
		loaders.push({ ...descriptor, key: fontKey, data: () => owned })
	}
	const entry: Entry = {
		renderer: new Backend({ cacheMaxBytes: RESOURCE_CACHE_BYTES }),
		fonts: loaders,
		fontBytes,
	}
	// Oversized sets still render, but cannot displace/retain the bounded warm cache.
	if (fontBytes > MAX_FONT_BYTES) return entry
	while (pool.entries.size >= MAX_RENDERERS || pool.fontBytes + fontBytes > MAX_FONT_BYTES) {
		const oldest = pool.entries.keys().next().value!
		pool.fontBytes -= pool.entries.get(oldest)!.fontBytes
		pool.entries.delete(oldest)
	}
	pool.entries.set(key, entry)
	pool.fontBytes += fontBytes
	return entry
}
