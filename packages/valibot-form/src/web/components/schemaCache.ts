import type { FormMeta } from '~/core/actions'
import { extractInfo } from '~/core/extract'

type CachedValue = ReturnType<typeof extractInfo> | null

let infoCache = new WeakMap<object, Map<string, CachedValue>>()

const EMPTY_META: FormMeta = {}
const KEY_SEPARATOR = '\u0000'

function stableSerialize(value: unknown): unknown {
	if (value === null) return null
	if (Array.isArray(value)) {
		return value.map((item) => stableSerialize(item))
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
		const normalized: Record<string, unknown> = {}
		for (const [key, entryValue] of entries) {
			normalized[key] = stableSerialize(entryValue)
		}
		return normalized
	}
	return value
}

function serializeMeta(meta?: FormMeta): string {
	if (!meta) return ''
	const normalized = stableSerialize(meta)
	return JSON.stringify(normalized)
}

function hasMetaEntries(meta: FormMeta): boolean {
	for (const value of Object.values(meta)) {
		if (value !== undefined) return true
	}
	return false
}

function getBucket(schema: object) {
	let bucket = infoCache.get(schema)
	if (!bucket) {
		bucket = new Map<string, CachedValue>()
		infoCache.set(schema, bucket)
	}
	return bucket
}

function buildCacheKey(fieldName: string, defaults?: FormMeta) {
	const safeFieldName = fieldName || '__root__'
	const metaKey = defaults ? serializeMeta(defaults) : ''
	return metaKey ? `${safeFieldName}${KEY_SEPARATOR}${metaKey}` : safeFieldName
}

/**
 * 缓存的字段信息提取
 * @param schema valibot schema
 * @param fieldName 字段名（会用于生成默认 label）
 * @param defaults 额外的默认 FormMeta，影响 label/描述等
 */
export function cachedExtractInfo(schema: object, fieldName: string, defaults?: FormMeta) {
	const metaForExtraction = defaults ?? EMPTY_META
	const metaForCache = hasMetaEntries(metaForExtraction) ? metaForExtraction : undefined
	const cacheKey = buildCacheKey(fieldName, metaForCache)
	const bucket = getBucket(schema)
	if (bucket.has(cacheKey)) {
		return bucket.get(cacheKey) ?? null
	}
	const info = extractInfo(schema as any, metaForExtraction, fieldName)
	bucket.set(cacheKey, info ?? null)
	return info ?? null
}

export function clearExtractInfoCache() {
	infoCache = new WeakMap<object, Map<string, CachedValue>>()
}
