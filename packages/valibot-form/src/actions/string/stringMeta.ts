// string/stringMeta.ts
import type { BaseMetadata } from 'valibot'
import type { CheckMetaType } from '~/utils'
import type { StringMetaOptions } from './type'

export interface stringMetaAction<TInput extends string, TMetadata extends StringMetaOptions>
	extends BaseMetadata<TInput> {
	readonly type: CheckMetaType<'string'>
	readonly reference: typeof stringMeta
	readonly metadata: TMetadata
}

/**
 * 一次性定义多种 string 状态
 *
 * @example
 *   // secret + copyable + placeholder
 *   const schema = string().pipe(
 *     stringMeta({ secret: true, copyable: true, placeholder: '请输入...' })
 *   )
 */
export function stringMeta<TInput extends string, const TMetadata extends StringMetaOptions>(
	metadata_: TMetadata,
): stringMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: 'string',
		reference: stringMeta,
		metadata: metadata_,
	}
}
