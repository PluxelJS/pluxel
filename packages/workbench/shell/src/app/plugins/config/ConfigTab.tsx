import { Accordion, Box } from '@mantine/core'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FieldNode } from 'valibot-form'
import { AutoForm, type AutoFormOptions, useAutoFormCtx } from 'valibot-form/web'

import { ServerValidationSummary } from '../../forms/serverValidation'
import { FormToc } from './components/FormToc'
import type { ConfigSectionForm } from './useConfigForms'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'

const EMPTY_PATH: readonly string[] = []

export function ConfigTabContent({
	displayName,
	fields,
	savedValue,
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
	showToc?: boolean
	path?: readonly string[]
	scrollHost?: HTMLElement | null
	scrollHostVersion?: number
	onSubmit: (key: string) => Promise<void>
	registerForm: (key: string, form: ConfigSectionForm) => () => void
}) {
	const initialValue = useMemo(() => savedValue, [savedValue])
	// Keep reset and React options aligned while the query publishes the saved configuration.
	// External input changes refresh only clean forms; drafts keep their original baseline.
	const [baseline, setBaseline] = useState(initialValue)
	const tabKey = path.join('.') || 'config'
	const anchorScope = useId()
	const sectionIdPrefix = `${anchorScope}-${makeSectionAnchorPrefix(displayName, tabKey)}`
	const fieldIdPrefix = `${anchorScope}-${makeFieldAnchorPrefix(displayName, tabKey)}`
	const opts = useMemo(
		() =>
			({
				defaultValues: baseline,
				canSubmitWhenInvalid: true,
				listeners: {
					onChange: ({ formApi }) => {
						// Field bindings clear their own errors; a summary can depend on any field.
						formApi.setErrorMap({ onServer: undefined })
					},
				},
				onSubmit: () => onSubmit(tabKey),
			}) satisfies AutoFormOptions<Record<string, unknown>>,
		[baseline, onSubmit, tabKey],
	)

	return (
		<AutoForm fields={fields} formOpts={opts}>
			<RegisterForm
				tabKey={tabKey}
				registerForm={registerForm}
				setBaseline={setBaseline}
				incomingValue={initialValue}
			/>
			{showToc ? (
				<Accordion mb="md">
					<Accordion.Item value="outline">
						<Accordion.Control>配置目录</Accordion.Control>
						<Accordion.Panel>
							<FormToc
								sectionIdPrefix={sectionIdPrefix}
								fieldIdPrefix={fieldIdPrefix}
								scrollHost={scrollHost}
								scrollHostVersion={scrollHostVersion}
							/>
						</Accordion.Panel>
					</Accordion.Item>
				</Accordion>
			) : null}
			<Box>
				<AutoForm.Fields sectionIdPrefix={sectionIdPrefix} fieldIdPrefix={fieldIdPrefix} />
				<ServerValidationSummary />
			</Box>
		</AutoForm>
	)
}

function RegisterForm({
	setBaseline,
	incomingValue,
	tabKey,
	registerForm,
}: {
	tabKey: string
	registerForm: (key: string, form: ConfigSectionForm) => () => void
	setBaseline: (values: Record<string, unknown>) => void
	incomingValue: Record<string, unknown>
}): null {
	const { form, reset, defaultValues } = useAutoFormCtx()
	const observedInput = useRef(incomingValue)
	useEffect(() => {
		if (observedInput.current === incomingValue) return
		observedInput.current = incomingValue
		if (!form.state.isDirty) {
			setBaseline(incomingValue)
			reset(incomingValue)
		}
	}, [defaultValues, form, incomingValue, reset, setBaseline])

	useEffect(() => {
		return registerForm(tabKey, {
			form,
			baseline: defaultValues,
			reset: (values) => {
				if (values) setBaseline(values)
				reset(values)
			},
			acceptSaved: (values, submitted) => {
				const acknowledged =
					JSON.stringify(values) === JSON.stringify(submitted) ? submitted : values
				setBaseline(acknowledged)
				if (form.state.values === submitted) reset(acknowledged)
			},
		})
	}, [defaultValues, form, registerForm, reset, setBaseline, tabKey])

	return null
}
