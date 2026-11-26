import { Accordion, Box } from '@mantine/core'
import { createAtom, useSelector } from '@tanstack/react-store'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FieldNode } from 'valibot-form'
import {
	AutoForm,
	buildEditableConfigPatch,
	prepareEditableConfigFields,
	type AutoFormOptions,
	useAutoFormCtx,
} from 'valibot-form/web'

import { FormToc } from './components/FormToc'
import type { ConfigSectionForm } from './useConfigForms'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'
import { ManagedBooleanField } from './ManagedBooleanField'

const configRenderers = { boolean: ManagedBooleanField }

export function ConfigTabContent({
	displayName,
	fields,
	savedValue,
	saving,
	showToc = true,
	tabKey,
	scrollHost,
	scrollHostVersion = 0,
	registerForm,
	onSubmit,
	onDraftChange,
}: {
	displayName: string
	fields: readonly FieldNode[]
	savedValue: Record<string, unknown>
	saving: boolean
	showToc?: boolean
	tabKey: string
	scrollHost?: HTMLElement | null
	scrollHostVersion?: number
	onSubmit: (key: string) => Promise<void>
	onDraftChange: () => void
	registerForm: (key: string, form: ConfigSectionForm) => () => void
}) {
	const initialValue = useMemo(() => savedValue, [savedValue])
	// Keep reset and React options aligned while the query publishes the saved configuration.
	// External input changes refresh only clean forms; drafts keep their original baseline.
	const [baseline, setBaseline] = useState(initialValue)
	const editableFields = useMemo(
		() => prepareEditableConfigFields(fields, baseline),
		[fields, baseline],
	)
	const anchorScope = useId()
	const sectionIdPrefix = `${anchorScope}-${makeSectionAnchorPrefix(displayName, tabKey)}`
	const fieldIdPrefix = `${anchorScope}-${makeFieldAnchorPrefix(displayName, tabKey)}`
	const opts = useMemo(
		() =>
			({
				defaultValues: baseline,
				canSubmitWhenInvalid: true,
				listeners: {
					// Field bindings clear their own errors; a summary can depend on any field.
					onChange: onDraftChange,
				},
				onSubmit: () => onSubmit(tabKey),
			}) satisfies AutoFormOptions<Record<string, unknown>>,
		[baseline, onDraftChange, onSubmit, tabKey],
	)

	return (
		<AutoForm fields={editableFields} formOpts={opts} renderers={configRenderers}>
			<RegisterForm
				fields={fields}
				tabKey={tabKey}
				registerForm={registerForm}
				saving={saving}
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
			</Box>
		</AutoForm>
	)
}

function RegisterForm({
	fields,
	setBaseline,
	incomingValue,
	saving,
	tabKey,
	registerForm,
}: {
	fields: readonly FieldNode[]
	saving: boolean
	tabKey: string
	registerForm: (key: string, form: ConfigSectionForm) => () => void
	setBaseline: (values: Record<string, unknown>) => void
	incomingValue: Record<string, unknown>
}): null {
	const { form, reset, defaultValues } = useAutoFormCtx()
	const latestSaved = useRef(incomingValue)
	const changes = useMemo(
		() =>
			createAtom(() => {
				const { values, isDirty } = form.store.get()
				return isDirty ? buildEditableConfigPatch(fields, values, defaultValues) : {}
			}),
		[defaultValues, fields, form],
	)
	const dirty = useSelector(changes, (patch) => Boolean(patch.set || patch.remove?.length))
	useEffect(() => {
		latestSaved.current = incomingValue
	}, [incomingValue])
	useEffect(() => {
		if (!saving && !dirty && latestSaved.current !== defaultValues) {
			setBaseline(latestSaved.current)
			reset(latestSaved.current)
		}
	}, [defaultValues, dirty, incomingValue, reset, saving, setBaseline])

	useEffect(() => {
		return registerForm(tabKey, {
			form,
			baseline: defaultValues,
			changes,
			reset: () => {
				setBaseline(latestSaved.current)
				reset(latestSaved.current)
			},
			acceptSaved: (values, submitted) => {
				latestSaved.current = values
				setBaseline(values)
				if (form.state.values === submitted) reset(values)
			},
		})
	}, [changes, defaultValues, form, registerForm, reset, setBaseline, tabKey])

	return null
}
