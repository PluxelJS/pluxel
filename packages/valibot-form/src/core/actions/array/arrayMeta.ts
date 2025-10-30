// array/arrayMeta.ts
import type { BaseMetadata } from 'valibot'
import type { CheckMetaType } from '~/utils'
import type { ArrayMetaOptions } from './type'

export interface arrayMetaAction<TInput extends unknown[], TMetadata extends ArrayMetaOptions>
	extends BaseMetadata<TInput> {
	readonly type: CheckMetaType<'array'>
	readonly reference: typeof arrayMeta
	readonly metadata: TMetadata
}

export function arrayMeta<TInput extends unknown[], const TMetadata extends ArrayMetaOptions>(
	metadata_: TMetadata,
): arrayMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: 'array',
		reference: arrayMeta,
		metadata: metadata_,
	}
}
