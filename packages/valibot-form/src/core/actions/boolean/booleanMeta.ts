import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'
import type { BooleanMetaOptions } from './type'

export type booleanMetaAction<TInput extends boolean, TMetadata extends BooleanMetaOptions> =
	MetadataAction<'boolean', TInput, TMetadata>

export const booleanMeta = createMetadataFactory<'boolean', boolean>('boolean')
