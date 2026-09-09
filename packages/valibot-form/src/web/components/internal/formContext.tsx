import type { PlannedField, SectionPlan } from './fieldPlanner'
import { DEFAULT_TEXTS } from '../../../core/constants'
import { useForm, type AnyFormApi } from '@tanstack/react-form'
import { createContext, useContext, useMemo, useRef, useState } from 'react'

export const FormResetVersion = createContext(0)

export function useAppForm<TValues>(
	defaultValues: TValues,
	formOpts?: { defaultValues?: TValues } & Record<string, unknown>,
) {
	const [resetVersion, setResetVersion] = useState(0)
	const resetRef = useRef<AnyFormApi['reset'] | undefined>(undefined)

	const opts = useMemo(() => {
		const listeners = formOpts?.listeners as AnyFormApi['options']['listeners'] | undefined
		return {
			...formOpts,
			defaultValues,
			listeners: {
				...listeners,
				onMount: (event: { formApi: AnyFormApi }) => {
					// React Form's returned facade differs from this core instance.
					// Both must share the reset that ends renderer editing sessions.
					if (resetRef.current) event.formApi.reset = resetRef.current
					listeners?.onMount?.(event)
				},
			},
		}
	}, [defaultValues, formOpts])

	const form = useForm(opts)
	const resetWithDrafts = useMemo(() => {
		const reset = form.reset
		const wrapped: typeof reset = (...args) => {
			reset(...args)
			setResetVersion((current) => current + 1)
		}
		return wrapped
	}, [form])
	form.reset = resetWithDrafts
	resetRef.current = resetWithDrafts
	return { form, resetVersion }
}

// -------- Context（暴露同一表单实例与渲染数据） ----------
interface Ctx<TValues extends Record<string, unknown>> {
	form: ReturnType<typeof useAppForm<TValues>>['form']
	sections: SectionPlan[]
	hiddenFields: PlannedField[]
	defaultValues: Record<string, unknown>
	submit: () => void
	reset: (values?: Record<string, unknown>) => void
}
export const AutoFormCtx = createContext<Ctx<Record<string, unknown>> | null>(null)

export function useAutoFormCtx<
	TValues extends Record<string, unknown> = Record<string, unknown>,
>() {
	const ctx = useContext(AutoFormCtx)
	if (!ctx) {
		throw new Error(DEFAULT_TEXTS.errors.autoFormContextMissing)
	}
	return ctx as Ctx<TValues>
}
