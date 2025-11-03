// string/stringMeta.ts
import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'
import type { StringMetaOptions } from './type'

export type stringMetaAction<TInput extends string, TMetadata extends StringMetaOptions> = MetadataAction<
	'string',
	TInput,
	TMetadata
>

/**
 * 一次性定义多种 string 状态
 *
 * @example
 *   // secret + copyable + placeholder
 *   const schema = string().pipe(
 *     stringMeta({ secret: true, copyable: true, placeholder: '请输入...' })
 *   )
 */
export const stringMeta = createMetadataFactory<'string', string>('string')
