import { Box } from '@mantine/core'
import { formOptions } from '@tanstack/react-form'
import { useEffect, useMemo } from 'react'
import type { PluginNodeAddress } from '@pluxel/core'
import type { FieldNode } from 'valibot-form'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'

import { useRuntimeManagementClient } from '../../../runtime'
import { useNotify } from '../../hooks/useNotify'
import { commitPluginConfig, refreshPluginConfig } from './usePluginConfig'
import { FormToc } from './components/FormToc'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'
import { buildEditableConfigPatch } from './presentationAdapter'
import { refreshPluginReadModels } from '../pluginReadModels'

const EMPTY_PATH: readonly string[] = []

export type ConfigFormState = {
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
	values: Record<string, unknown>
}

export type ConfigFormBridge = {
	form: ReturnType<typeof useAutoFormCtx>['form']
	reset: (values?: Record<string, unknown>) => void
	submit: () => void
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
	const initialValue = useMemo(
		() => ({ ...defaultValue, ...savedValue }),
		[defaultValue, savedValue],
	)
	const tabKey = path.join('.') || 'config'
	const sectionIdPrefix = makeSectionAnchorPrefix(displayName, tabKey)
	const fieldIdPrefix = makeFieldAnchorPrefix(displayName, tabKey)
	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: initialValue,
				onSubmit: async ({ value, formApi }) => {
					const patch = buildEditableConfigPatch(fields, value, savedValue)
					const result = await (path.length === 0
						? management.config.patch(owner, patch)
						: management.config.patchField(owner, {
								fieldPath: path.join('.'),
								value: { ...persistedValue, ...patch },
							}))
					if (result.ok === false) {
						if (result.state === 'unknown') {
							await Promise.all([
								refreshPluginConfig(management, owner),
								refreshPluginReadModels(management),
							])
						}
						notify({
							title: '提交失败',
							message: result.message ?? result.code ?? '未知错误',
							color: 'red',
						})
						return
					}
					commitPluginConfig(management, owner, result.config)
					await refreshPluginReadModels(management)
					formApi.reset(value)
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
		[fields, initialValue, management, notify, owner, path, persistedValue, savedValue],
	)

	return (
		<AutoForm fields={fields} formOpts={opts}>
			{registerForm ? <FormBridge tabKey={tabKey} registerForm={registerForm} /> : null}
			{reportState ? <FormStateSlot tabKey={tabKey} reportState={reportState} /> : null}
			<Box px="xs" pt="xs" pb={24}>
				<AutoForm.Fields sectionIdPrefix={sectionIdPrefix} fieldIdPrefix={fieldIdPrefix} />
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
	tabKey,
	registerForm,
}: {
	tabKey: string
	registerForm: (key: string, bridge: ConfigFormBridge) => void | (() => void)
}): null {
	const { form, reset, submit } = useAutoFormCtx<any>()

	useEffect(() => {
		const dispose = registerForm(tabKey, { form, reset, submit })
		return () => {
			if (typeof dispose === 'function') dispose()
		}
	}, [form, registerForm, reset, submit, tabKey])

	return null
}

function FormStateSlot({
	tabKey,
	reportState,
}: {
	tabKey: string
	reportState: (key: string, state: ConfigFormState) => void
}) {
	const { form } = useAutoFormCtx<any>()
	return (
		<form.Subscribe
			selector={(state: any) => ({
				dirty: Boolean(state.isDirty),
				canSubmit: Boolean(state.canSubmit),
				submitting: Boolean(state.isSubmitting),
				values: state.values as Record<string, unknown>,
			})}
		>
			{(state) => <FormStateEffect tabKey={tabKey} state={state} reportState={reportState} />}
		</form.Subscribe>
	)
}

function FormStateEffect({
	tabKey,
	state,
	reportState,
}: {
	tabKey: string
	state: ConfigFormState
	reportState: (key: string, state: ConfigFormState) => void
}): null {
	useEffect(() => {
		reportState(tabKey, state)
	}, [reportState, state, tabKey])

	return null
}
