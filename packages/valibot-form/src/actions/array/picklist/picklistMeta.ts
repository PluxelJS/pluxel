import type { BaseMetadata, PicklistOptions } from 'valibot'
import type { CheckMetaType } from '~/utils'
import type { PicklistMetaOptions } from './type'

export interface picklistMetaAction<
	TInput extends PicklistOptions,
	TMetadata extends PicklistMetaOptions,
> extends BaseMetadata<TInput> {
	readonly type: CheckMetaType<'picklist'>
	readonly reference: typeof picklistMeta
	readonly metadata: TMetadata
}

export function picklistMeta<
	TInput extends PicklistOptions,
	const TMetadata extends PicklistMetaOptions,
>(metadata_: TMetadata): picklistMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: 'picklist',
		reference: picklistMeta,
		metadata: metadata_,
	}
}
