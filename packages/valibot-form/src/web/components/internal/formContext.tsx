import { useForm } from '@tanstack/react-form'
import { useMemo } from 'react'
import type { ObjectLikeSchema } from '../../../core'
import { getDefaults } from 'valibot'

export function useAppForm<TValues>(
	schema: ObjectLikeSchema | undefined,
	formOpts?: { defaultValues?: TValues } & Record<string, unknown>,
) {
	const defaultValues = useMemo(
		() => (formOpts?.defaultValues ?? (schema === undefined ? {} : getDefaults(schema))) as TValues,
		[schema, formOpts?.defaultValues],
	)

	const opts = useMemo(
		() => ({
			defaultValues,
			...formOpts,
		}),
		[defaultValues, formOpts],
	)

	return useForm(opts)
}
