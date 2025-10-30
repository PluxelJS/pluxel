import type { BaseMetadata } from 'valibot'
import type { CheckMetaType } from '~/utils'

export interface FormMeta {
	title: string
	description?: string
}

export interface formMetaAction<TInput, TMetadata extends FormMeta> extends BaseMetadata<TInput> {
	/**
	 * The action type.
	 */
	readonly type: CheckMetaType<'form'>
	/**
	 * The action reference.
	 */
	readonly reference: typeof formMeta
	/**
	 * The metadata object.
	 */
	readonly metadata: TMetadata
}

/**
 * Creates a custom metadata action.
 *
 * @param metadata_ The metadata object.
 *
 * @returns A metadata action.
 */
// @__NO_SIDE_EFFECTS__
export function formMeta<TInput, const TMetadata extends FormMeta>(
	metadata_: TMetadata,
): formMetaAction<TInput, TMetadata> {
	return {
		kind: 'metadata',
		type: 'form',
		reference: formMeta,
		metadata: metadata_,
	}
}
