import type { BaseMetadata } from 'valibot'
import type { CheckMetaType } from '~/utils'

export interface ObjectMetaOptions {
	collapse?: true
}

export interface objectMetaAction<TInput extends object, TMetadata extends ObjectMetaOptions>
	extends BaseMetadata<TInput> {
	readonly type: CheckMetaType<'object'>
	readonly reference: typeof objectMeta
	readonly metadata: TMetadata
}

/**
 * 一次性定义多种 string 状态
 *
 * @example
 *   // secret + copyable + placeholder
 *   const schema = string().pipe(
 *     objectMeta({ secret: true, copyable: true, placeholder: '请输入...' })
 *   )
 */
export function objectMeta<TInput extends object, const TMetadata extends ObjectMetaOptions>(
	metadata_: TMetadata,
): objectMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: 'object',
		reference: objectMeta,
		metadata: metadata_,
	}
}
