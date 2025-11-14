import { extractInfo } from '~/core/extract'

const infoCache = new WeakMap<object, ReturnType<typeof extractInfo> | null>()

/**
 * 缓存的字段信息提取
 * @param schema valibot schema
 * @param fieldName 字段名（会用于生成默认 label）
 */
export function cachedExtractInfo(schema: object, fieldName: string) {
	const cached = infoCache.get(schema)
	if (cached !== undefined) return cached
	const info = extractInfo(schema as any, { label: undefined }, fieldName)
	infoCache.set(schema, info ?? null)
	return info ?? null
}
