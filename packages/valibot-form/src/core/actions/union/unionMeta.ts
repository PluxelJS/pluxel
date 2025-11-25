// union/unionMeta.ts
import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'
import type { UnionMetaOptions } from './type'

export type unionMetaAction<TInput, TMetadata extends UnionMetaOptions> = MetadataAction<
	'union',
	TInput,
	TMetadata
>

export const unionMeta = createMetadataFactory<'union', unknown>('union')
