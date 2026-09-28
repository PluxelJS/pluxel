import { createAtom, shallow, useSelector } from '@tanstack/react-store'
import { useState } from 'react'
import type { useAutoFormCtx } from 'valibot-form/web'

export type ConfigFormState = {
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
}

export type ConfigSectionForm = {
	form: ReturnType<typeof useAutoFormCtx>['form']
	reset: (values?: Record<string, unknown>) => void
	acceptSaved: (values: Record<string, unknown>) => void
}

/** TanStack tracks the registered form stores; React reads only the action dock's flags. */
export function useConfigForms() {
	const [registry] = useState(createConfigForms)
	const formStates = useSelector(registry.states)
	return {
		forms: registry.forms,
		registerForm: registry.registerForm,
		formStates,
	}
}

function createConfigForms() {
	const forms = createAtom<Record<string, ConfigSectionForm>>({})
	const states = createAtom<Record<string, ConfigFormState>>(
		() =>
			Object.fromEntries(
				Object.entries(forms.get()).map(([key, { form }]) => {
					const { isDirty: dirty, canSubmit, isSubmitting: submitting } = form.store.get()
					return [key, { dirty, canSubmit, submitting }]
				}),
			),
		{
			compare: (left, right) =>
				Object.keys(left).length === Object.keys(right).length &&
				Object.entries(left).every(([key, state]) => shallow(state, right[key])),
		},
	)
	return {
		states,
		forms,
		registerForm(key: string, bridge: ConfigSectionForm) {
			forms.set((current) => ({ ...current, [key]: bridge }))
			return () => {
				forms.set((current) => {
					if (current[key] !== bridge) return current
					const next = { ...current }
					delete next[key]
					return next
				})
			}
		},
	}
}
