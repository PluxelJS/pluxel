// record/recordMeta.ts
import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'
import type { RecordMetaOptions } from './type'

export type recordMetaAction<
	TInput extends Record<string, unknown>,
	TMetadata extends RecordMetaOptions,
> = MetadataAction<'record', TInput, TMetadata>

export const recordMeta = createMetadataFactory<'record', Record<string, unknown>>('record')
