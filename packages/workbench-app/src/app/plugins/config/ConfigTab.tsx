import { Box, Button, Group } from '@mantine/core'
import { formOptions } from '@tanstack/react-form'
import { useMemo } from 'react'
import type { PluginNodeAddressSnapshot } from '@pluxel/core'
import type { ObjectSchema } from 'valibot'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'

import { patchPluginConfig, useRuntimeTransportClient, type ConfigResult } from '../../../runtime'
import { useNotify } from '../../hooks/useNotify'
import { commitPluginConfig } from './usePluginConfig'
import { FormToc } from './components/FormToc'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'

export function ConfigTabContent({
	owner,
	displayName,
	schema,
	savedValue,
	defaultValue,
	showToc = true,
	showActions = true,
	active = true,
	onDirtyChange,
}: {
	owner: PluginNodeAddressSnapshot
	displayName: string
	schema: ObjectSchema<any, any>
	savedValue: Record<string, unknown>
	defaultValue: Record<string, unknown>
	showToc?: boolean
	showActions?: boolean
	active?: boolean
	onDirtyChange?: (dirty: boolean) => void
}) {
	const notify = useNotify()
	const transport = useRuntimeTransportClient()
	const initialValue = useMemo(
		() => ({ ...defaultValue, ...savedValue }),
		[defaultValue, savedValue],
	)
	const sectionIdPrefix = makeSectionAnchorPrefix(displayName, 'config')
	const fieldIdPrefix = makeFieldAnchorPrefix(displayName, 'config')
	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: initialValue,
				onSubmit: async ({ value, formApi }) => {
					const result = (await transport.withRpc((rpc) =>
						patchPluginConfig(rpc, owner, value),
					)) as ConfigResult
					if (result.ok === false) {
						notify({
							title: '提交失败',
							message: result.message ?? result.code ?? '未知错误',
							color: 'red',
						})
						return
					}
					commitPluginConfig(owner, displayName, result.config)
					formApi.reset(value)
					notify({ title: '提交成功', message: '配置已保存', color: 'green' })
				},
			}),
		[displayName, initialValue, notify, owner, transport],
	)

	return (
		<AutoForm schema={schema as any} formOpts={opts}>
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
				<ConfigActions initialValue={initialValue} defaultValue={defaultValue} />
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
	initialValue,
	defaultValue,
}: {
	initialValue: Record<string, unknown>
	defaultValue: Record<string, unknown>
}) {
	const { form, reset, submit } = useAutoFormCtx<any>()
	const restoreDefaults = () => {
		for (const key of new Set([...Object.keys(initialValue), ...Object.keys(defaultValue)])) {
			form.setFieldValue(key, defaultValue[key])
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
