import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'

export interface FormMeta {
	title: string
	description?: string
}

export type formMetaAction<TInput, TMetadata extends FormMeta> = MetadataAction<'form', TInput, TMetadata>

/**
 * Creates a custom metadata action.
 *
 * @param metadata_ The metadata object.
 *
 * @returns A metadata action.
 */
// @__NO_SIDE_EFFECTS__
export const formMeta = createMetadataFactory<'form'>('form')
