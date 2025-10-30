// src/formContext.ts

import { type formOptions, useForm } from '@tanstack/react-form'
import { useMemo } from 'react'
import { getDefaults, type InferOutput, type ObjectSchema } from 'valibot'

// —— 辅助：读取服务端注入的表单状态 —— //
function getServerFormState<FormState>() {
	if (typeof window === 'undefined') return undefined
	const el = document.getElementById('__TANSTACK_FORM_STATE__')
	if (!el) return undefined
	try {
		return JSON.parse(el.textContent!) as FormState
	} catch {
		return undefined
	}
}

export function useAppForm<S extends ObjectSchema<any, any>, TValues = InferOutput<S>>(
	schema: S,
	formOpts?: ReturnType<typeof formOptions<InferOutput<S>>>,
) {
	// 1. 先拿到默认值
	const defaultValues = useMemo(
		() => (formOpts?.defaultValues ?? getDefaults(schema)) as TValues,
		[schema, formOpts?.defaultValues],
	)

	// const serverState = useMemo(() => getServerFormState(), [])

	// 2. 合并默认值 + 调用者传来的那个整包配置
	const opts = useMemo(
		() => ({
			defaultValues,
			...(formOpts ?? {}),
			/* transform: useTransform(
				(base) => mergeForm(base, serverState as any),
				[serverState],
			), */
		}),
		[defaultValues, formOpts],
	)

	// 3. 传给 useForm
	return useForm(opts)
}
