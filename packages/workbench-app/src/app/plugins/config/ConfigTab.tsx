import { Box, Button, Group } from '@mantine/core'
import { formOptions } from '@tanstack/react-form'
import { useMemo } from 'react'
import type { PluginNodeAddress } from '@pluxel/core'
import type { FieldNode } from 'valibot-form'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'

import { useRuntimeManagementClient } from '../../../runtime'
import { useNotify } from '../../hooks/useNotify'
import { commitPluginConfig, refreshPluginConfig } from './usePluginConfig'
import { FormToc } from './components/FormToc'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'
import { buildEditableConfigPatch } from './presentationAdapter'

const EMPTY_PATH: readonly string[] = []

export function ConfigTabContent({
	owner,
	displayName,
	fields,
	savedValue,
	defaultValue,
	showToc = true,
	showActions = true,
	active = true,
	onDirtyChange,
	path = EMPTY_PATH,
}: {
	owner: PluginNodeAddress
	displayName: string
	fields: readonly FieldNode[]
	savedValue: Record<string, unknown>
	defaultValue: Record<string, unknown>
	showToc?: boolean
	showActions?: boolean
	active?: boolean
	onDirtyChange?: (dirty: boolean) => void
	path?: readonly string[]
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
								value: { ...savedValue, ...patch },
							}))
					if (result.ok === false) {
						if (result.state === 'unknown') {
							await refreshPluginConfig(management, owner)
						}
						notify({
							title: '提交失败',
							message: result.message ?? result.code ?? '未知错误',
							color: 'red',
						})
						return
					}
					commitPluginConfig(management, owner, result.config)
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
		[fields, initialValue, management, notify, owner, path, savedValue],
	)

	return (
		<AutoForm fields={fields} formOpts={opts}>
			{onDirtyChange ? <DirtyReporter onDirtyChange={onDirtyChange} /> : null}
			<Box px="xs" pb={24}>
				<AutoForm.Fields sectionIdPrefix={sectionIdPrefix} fieldIdPrefix={fieldIdPrefix} />
			</Box>
			{showToc ? (
				<FormToc
					sectionIdPrefix={sectionIdPrefix}
					fieldIdPrefix={fieldIdPrefix}
					scrollHost={null}
					scrollHostVersion={0}
				/>
			) : null}
			{showActions && active ? (
				<ConfigActions fields={fields} initialValue={initialValue} defaultValue={defaultValue} />
			) : null}
		</AutoForm>
	)
}

function DirtyReporter({ onDirtyChange }: { onDirtyChange(dirty: boolean): void }) {
	const { form } = useAutoFormCtx<any>()
	return (
		<form.Subscribe selector={(state: any) => state.isDirty}>
			{(dirty) => {
				queueMicrotask(() => onDirtyChange(Boolean(dirty)))
				return null
			}}
		</form.Subscribe>
	)
}

function ConfigActions({
	fields,
	initialValue,
	defaultValue,
}: {
	fields: readonly FieldNode[]
	initialValue: Record<string, unknown>
	defaultValue: Record<string, unknown>
}) {
	const { form, reset, submit } = useAutoFormCtx<any>()
	const restoreDefaults = () => {
		const editableDefaults = buildEditableConfigPatch(fields, defaultValue, initialValue)
		for (const [key, value] of Object.entries(editableDefaults)) {
			form.setFieldValue(key, value)
		}
	}
	return (
		<form.Subscribe
			selector={(state: any) => ({
				dirty: state.isDirty,
				canSubmit: state.canSubmit,
				submitting: state.isSubmitting,
			})}
		>
			{({ dirty, canSubmit, submitting }) => (
				<Group justify="flex-end" gap="xs" px="xs" pb="md">
					<Button
						size="xs"
						variant="default"
						disabled={!dirty || submitting}
						onClick={() => reset(initialValue)}
					>
						撤销
					</Button>
					<Button size="xs" variant="subtle" disabled={submitting} onClick={restoreDefaults}>
						恢复默认
					</Button>
					<Button
						size="xs"
						disabled={!dirty || !canSubmit || submitting}
						loading={submitting}
						onClick={() => void submit()}
					>
						保存
					</Button>
				</Group>
			)}
		</form.Subscribe>
	)
}

export function ConfigTabPanel(props: Parameters<typeof ConfigTabContent>[0]) {
	return <ConfigTabContent {...props} />
}
