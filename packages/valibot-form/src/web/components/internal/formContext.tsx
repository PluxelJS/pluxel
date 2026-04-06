import { useForm } from '@tanstack/react-form'
import { useMemo } from 'react'
import type { ObjectLikeSchema } from '../../../core'
import { getDefaults, type InferOutput } from 'valibot'

export function useAppForm<S extends ObjectLikeSchema, TValues = InferOutput<S>>(
	schema: S,
	formOpts?: { defaultValues?: TValues } & Record<string, unknown>,
) {
	const defaultValues = useMemo(
		() => (formOpts?.defaultValues ?? getDefaults(schema)) as TValues,
		[schema, formOpts?.defaultValues],
	)

	const opts = useMemo(
		() => ({
			defaultValues,
			...formOpts,
		}),
		[defaultValues, formOpts],
	)

	return useForm(opts as any)
}
