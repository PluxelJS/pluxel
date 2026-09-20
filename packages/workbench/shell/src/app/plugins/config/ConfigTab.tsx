import { Box } from '@mantine/core'
import { formOptions } from '@tanstack/react-form'
import { useEffect, useMemo, useState } from 'react'
import type { FieldNode } from 'valibot-form'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'

import { ServerValidationSummary } from '../../forms/serverValidation'
import { FormToc } from './components/FormToc'
import type { ConfigSectionForm } from './useConfigForms'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'

const EMPTY_PATH: readonly string[] = []

export function ConfigTabContent({
	displayName,
	fields,
	savedValue,
	defaultValue,
	showToc = true,
	path = EMPTY_PATH,
	scrollHost,
	scrollHostVersion = 0,
	registerForm,
	onSubmit,
}: {
	displayName: string
	fields: readonly FieldNode[]
	savedValue: Record<string, unknown>
	defaultValue: Record<string, unknown>
	showToc?: boolean
	path?: readonly string[]
	scrollHost?: HTMLElement | null
	scrollHostVersion?: number
	onSubmit: (key: string) => Promise<void>
	registerForm: (key: string, form: ConfigSectionForm) => () => void
}) {
	const initialValue = useMemo(
		() => ({ ...defaultValue, ...savedValue }),
		[defaultValue, savedValue],
	)
	// Keep reset and React options aligned while the query publishes the saved configuration.
	// Subsequent external configuration/default changes remain authoritative.
	const [baseline, setBaseline] = useState(initialValue)
	useEffect(() => setBaseline(initialValue), [initialValue])
	const tabKey = path.join('.') || 'config'
	const sectionIdPrefix = makeSectionAnchorPrefix(displayName, tabKey)
	const fieldIdPrefix = makeFieldAnchorPrefix(displayName, tabKey)
	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: baseline,
				canSubmitWhenInvalid: true,
				listeners: {
					onChange: ({ formApi }) => {
						// Field bindings clear their own errors; a summary can depend on any field.
						formApi.setErrorMap({ onServer: undefined })
					},
				},
				onSubmit: () => onSubmit(tabKey),
			}),
		[baseline, onSubmit, tabKey],
	)

	return (
		<AutoForm fields={fields} formOpts={opts}>
			<RegisterForm tabKey={tabKey} registerForm={registerForm} setBaseline={setBaseline} />
			<Box px="xs" pt="xs" pb={24}>
				<AutoForm.Fields sectionIdPrefix={sectionIdPrefix} fieldIdPrefix={fieldIdPrefix} />
				<ServerValidationSummary />
			</Box>
			{showToc ? (
				<FormToc
					sectionIdPrefix={sectionIdPrefix}
					fieldIdPrefix={fieldIdPrefix}
					scrollHost={scrollHost}
					scrollHostVersion={scrollHostVersion}
				/>
			) : null}
		</AutoForm>
	)
}

function RegisterForm({
	setBaseline,
	tabKey,
	registerForm,
}: {
	tabKey: string
	registerForm: (key: string, form: ConfigSectionForm) => () => void
	setBaseline: (values: Record<string, unknown>) => void
}): null {
	const { form, reset } = useAutoFormCtx()

	useEffect(() => {
		return registerForm(tabKey, {
			form,
			reset: (values) => {
				if (values) setBaseline(values)
				reset(values)
			},
			acceptSaved: (values) => {
				setBaseline(values)
				if (form.state.values === values) reset(values)
			},
		})
	}, [form, registerForm, reset, setBaseline, tabKey])

	return null
}
