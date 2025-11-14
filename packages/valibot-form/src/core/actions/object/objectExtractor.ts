import { META_MAP, collectObjectEntries, type Schema } from '~/core/utils'
import type { ObjectMetaResult } from './type'

type InputSchema = Schema & { type: 'object' | 'intersect'; pipe?: readonly unknown[] }

const isDevEnv = () => {
	if (typeof process === 'undefined') return true
	return process.env?.NODE_ENV !== 'production'
}

function readObjectMetadata(schema: InputSchema) {
	const meta: Partial<ObjectMetaResult> = {}
	const pipe = schema.pipe
	if (!pipe) return meta

	for (let i = pipe.length - 1; i >= 0; i--) {
		const item = pipe[i] as { kind?: string; type?: string; metadata?: Partial<ObjectMetaResult> }
		if (item?.kind === 'metadata' && item.type === META_MAP.object) {
			Object.assign(meta, item.metadata)
			break
		}
	}

	return meta
}

/**
 * Extracts nested fields & metadata from object/intersection schemas so that renderers can render recursively.
 */
export function extractObjectProps(schema: InputSchema): ObjectMetaResult {
	const fields = collectObjectEntries(schema)
	if (!fields && isDevEnv()) {
		console.warn(
			'[valibot-form] Received non-object schema while extracting object props. The field will be ignored.',
		)
	}

	return {
		fields: fields ?? [],
		...readObjectMetadata(schema),
	}
}
