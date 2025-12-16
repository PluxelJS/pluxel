// picklist/picklistMeta.ts
import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'
import type { PicklistMetaOptions } from './type'

export type picklistMetaAction<
	TInput extends string | number,
	TMetadata extends PicklistMetaOptions,
> = MetadataAction<'picklist', TInput, TMetadata>

export const picklistMeta = createMetadataFactory<'picklist', string | number>('picklist')
