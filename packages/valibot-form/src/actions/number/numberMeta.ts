import type { BaseMetadata } from 'valibot'
import { MetaType } from '~/utils'
import type { NumberMetaOptions } from './type'

/** Unified metadata action for number inputs */
export interface numberMetaAction<
	TInput extends number,
	TMetadata extends NumberMetaOptions,
> extends BaseMetadata<TInput> {
	readonly type: MetaType.NUMBER
	readonly reference: typeof numberMeta
	readonly metadata: TMetadata
}

/**
 * Core factory: attach metadata for any number input type
 */
export function numberMeta<
	TInput extends number,
	const TMetadata extends NumberMetaOptions,
>(metadata: TMetadata): numberMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: MetaType.NUMBER,
		reference: numberMeta,
		metadata,
	}
}
