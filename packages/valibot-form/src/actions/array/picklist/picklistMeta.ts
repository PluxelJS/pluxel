import type { BaseMetadata, PicklistOptions } from 'valibot'
import { MetaType } from '~/utils'
import type { PicklistMetaOptions } from './type'

export interface picklistMetaAction<
	TInput extends PicklistOptions,
	TMetadata extends PicklistMetaOptions,
> extends BaseMetadata<TInput> {
	readonly type: MetaType.PICKLIST
	readonly reference: typeof picklistMeta
	readonly metadata: TMetadata
}

export function picklistMeta<
	TInput extends PicklistOptions,
	const TMetadata extends PicklistMetaOptions,
>(metadata_: TMetadata): picklistMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: MetaType.PICKLIST,
		reference: picklistMeta,
		metadata: metadata_,
	}
}
