import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'

export interface ObjectMetaOptions {
	collapse?: true
	columns?: number
	variant?: 'card' | 'stack'
	gap?: number | string
}

export type objectMetaAction<
	TInput extends object,
	TMetadata extends ObjectMetaOptions,
> = MetadataAction<'object', TInput, TMetadata>

/**
 * 一次性定义多种 string 状态
 *
 * @example
 *   // secret + copyable + placeholder
 *   const schema = string().pipe(
 *     objectMeta({ secret: true, copyable: true, placeholder: '请输入...' })
 *   )
 */
export const objectMeta = createMetadataFactory<'object', object>('object')
