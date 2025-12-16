import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'
import type { NumberMetaOptions } from './type'

/** Unified metadata action for number inputs */
export type numberMetaAction<
	TInput extends number,
	TMetadata extends NumberMetaOptions,
> = MetadataAction<'number', TInput, TMetadata>

/**
 * Core factory: attach metadata for any number input type
 */
export const numberMeta = createMetadataFactory<'number', number>('number')
