// array/arrayMeta.ts
import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'
import type { ArrayMetaOptions } from './type'

export type arrayMetaAction<
	TInput extends unknown[],
	TMetadata extends ArrayMetaOptions,
> = MetadataAction<'array', TInput, TMetadata>

export const arrayMeta = createMetadataFactory<'array', unknown[]>('array')
