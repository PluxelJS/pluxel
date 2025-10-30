import type { BaseMetadata } from 'valibot'
import type { CheckMetaType } from '~/utils'
import type { NumberMetaOptions } from './type'

/** Unified metadata action for number inputs */
export interface numberMetaAction<TInput extends number, TMetadata extends NumberMetaOptions>
	extends BaseMetadata<TInput> {
	readonly type: CheckMetaType<'number'>
	readonly reference: typeof numberMeta
	readonly metadata: TMetadata
}

/**
 * Core factory: attach metadata for any number input type
 */
export function numberMeta<TInput extends number, const TMetadata extends NumberMetaOptions>(
	metadata: TMetadata,
): numberMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: 'number',
		reference: numberMeta,
		metadata,
	}
}
