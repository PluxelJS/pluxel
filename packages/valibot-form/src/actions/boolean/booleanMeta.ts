import type { BaseMetadata } from 'valibot'
import type { CheckMetaType } from '~/utils'
import type { BooleanMetaOptions } from './type'

export interface booleanMetaAction<
	TInput extends boolean,
	TMetadata extends BooleanMetaOptions,
> extends BaseMetadata<TInput> {
	readonly type: CheckMetaType<'boolean'>
	readonly reference: typeof booleanMeta
	readonly metadata: TMetadata
}

export function booleanMeta<
	TInput extends boolean,
	const TMetadata extends BooleanMetaOptions,
>(metadata_: TMetadata): booleanMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: 'boolean',
		reference: booleanMeta,
		metadata: metadata_,
	}
}
