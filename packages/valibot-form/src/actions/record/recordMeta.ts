// record/recordMeta.ts
import type { BaseMetadata } from 'valibot'
import type { CheckMetaType } from '~/utils'
import type { RecordMetaOptions } from './type'

export interface recordMetaAction<
	TInput extends Record<string, unknown>,
	TMetadata extends RecordMetaOptions,
> extends BaseMetadata<TInput> {
	readonly type: CheckMetaType<'record'>
	readonly reference: typeof recordMeta
	readonly metadata: TMetadata
}

export function recordMeta<
	TInput extends Record<string, unknown>,
	const TMetadata extends RecordMetaOptions,
>(metadata_: TMetadata): recordMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: 'record',
		reference: recordMeta,
		metadata: metadata_,
	}
}
