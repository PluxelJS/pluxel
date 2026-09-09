import { Box } from '@mantine/core'
import { formOptions } from '@tanstack/react-form'
import { useSelector } from '@tanstack/react-store'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { PluginNodeAddress } from '@pluxel/core'
import type { FieldNode } from 'valibot-form'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'

import { useRuntimeManagementClient } from '../../../runtime'
import { useNotify } from '../../hooks/useNotify'
import { commitPluginConfig, refreshPluginConfig } from './usePluginConfig'
import {
	mapConfigValidationErrors,
	mountedFieldNames,
	ServerValidationSummary,
} from '../../forms/serverValidation'
import { FormToc } from './components/FormToc'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'
import { buildEditableConfigPatch } from './presentationAdapter'
import { refreshPluginReadModels } from '../pluginReadModels'

const EMPTY_PATH: readonly string[] = []

export type ConfigFormState = {
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
}

export type ConfigFormBridge = {
	form: ReturnType<typeof useAutoFormCtx>['form']
	reset: (values?: Record<string, unknown>) => void
	submit: () => void
	acceptSaved: (values: Record<string, unknown>) => void
}

export function ConfigTabContent({
	owner,
	displayName,
	fields,
	savedValue,
	defaultValue,
	showToc = true,
	path = EMPTY_PATH,
	persistedValue = savedValue,
	scrollHost,
	scrollHostVersion = 0,
	registerForm,
	reportState,
}: {
	owner: PluginNodeAddress
	displayName: string
	fields: readonly FieldNode[]
	savedValue: Record<string, unknown>
	defaultValue: Record<string, unknown>
	showToc?: boolean
	path?: readonly string[]
	/** Full value at `path`, including child sections that are not rendered by this form. */
	persistedValue?: Record<string, unknown>
	scrollHost?: HTMLElement | null
	scrollHostVersion?: number
	registerForm?: (key: string, bridge: ConfigFormBridge) => void | (() => void)
	reportState?: (key: string, state: ConfigFormState) => void
}) {
	const notify = useNotify()
	const management = useRuntimeManagementClient()
	const queryClient = useQueryClient()
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
				onSubmit: async ({ value, formApi }) => {
					formApi.setErrorMap({ onServer: { fields: {} } } as never)
					const patch = buildEditableConfigPatch(fields, value, savedValue)
					const result = await (path.length === 0
						? management.config.patch(owner, patch)
						: management.config.patchField(owner, {
								fieldPath: path.join('.'),
								value: { ...persistedValue, ...patch },
							}))
					if (result.ok === false) {
						if (result.code === 'validation_failed' && formApi.state.values === value) {
							formApi.setErrorMap({
								onServer: mapConfigValidationErrors(
									result.errors,
									mountedFieldNames(formApi),
									path,
								),
							} as never)
						}
						if (result.state === 'unknown') {
							await Promise.all([
								refreshPluginConfig(queryClient, owner),
								refreshPluginReadModels(queryClient),
							])
						}
						notify({
							title: '提交失败',
							message: result.message ?? result.code ?? '未知错误',
							color: 'red',
						})
						return
					}
					setBaseline(value)
					commitPluginConfig(queryClient, owner, result.config)
					await refreshPluginReadModels(queryClient)
					// TanStack updates values immutably, including reset. Never overwrite a newer draft.
					if (formApi.state.values === value) formApi.reset(value)
					if (result.application === 'saved-not-applied') {
						notify({
							title: '配置已保存，但尚未应用',
							message:
								result.saved === true
									? result.applyFailure.message
									: '运行中的插件尚未应用当前配置。',
							color: 'yellow',
						})
					} else {
						notify({
							title: '提交成功',
							message:
								result.application === 'deferred'
									? '配置已保存，将在插件启动时应用'
									: '配置已保存并应用',
							color: 'green',
						})
					}
				},
			}),
		[fields, baseline, management, notify, owner, path, persistedValue, queryClient, savedValue],
	)

	return (
		<AutoForm fields={fields} formOpts={opts}>
			{registerForm ? (
				<FormBridge tabKey={tabKey} registerForm={registerForm} setBaseline={setBaseline} />
			) : null}
			{reportState ? <FormStateSlot tabKey={tabKey} reportState={reportState} /> : null}
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

function FormBridge({
	setBaseline,
	tabKey,
	registerForm,
}: {
	tabKey: string
	registerForm: (key: string, bridge: ConfigFormBridge) => void | (() => void)
	setBaseline: (values: Record<string, unknown>) => void
}): null {
	const { form, reset, submit } = useAutoFormCtx<any>()

	useEffect(() => {
		const dispose = registerForm(tabKey, {
			form,
			reset: (values) => {
				if (values) setBaseline(values)
				reset(values)
			},
			submit,
			acceptSaved: (values) => {
				setBaseline(values)
				if (form.state.values === values) reset(values)
			},
		})
		return () => {
			if (typeof dispose === 'function') dispose()
		}
	}, [form, registerForm, reset, setBaseline, submit, tabKey])

	return null
}

function FormStateSlot({
	tabKey,
	reportState,
}: {
	tabKey: string
	reportState: (key: string, state: ConfigFormState) => void
}): null {
	const { form } = useAutoFormCtx()
	const dirty = useSelector(form.store, (state) => state.isDirty)
	const canSubmit = useSelector(form.store, (state) => state.canSubmit)
	const submitting = useSelector(form.store, (state) => state.isSubmitting)

	useEffect(() => {
		reportState(tabKey, { dirty, canSubmit, submitting })
	}, [reportState, tabKey, dirty, canSubmit, submitting])

	return null
}
