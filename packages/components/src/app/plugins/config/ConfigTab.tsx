import { Box, Tabs } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { formOptions } from '@tanstack/react-form'
import { useMemo } from 'react'
import type { ObjectSchema } from 'valibot'
import { AutoForm } from 'valibot-form/web'
import { useNotify } from '../../hooks'
import { createRpcClient } from '../../rpc'
import { FloatingBar } from './components/FloatingBar'
import { FormToc } from './components/FormToc'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './utils'

export function ConfigTabContent({
	pluginName,
	tabKey,
	schema,
	savedValue,
	defaultValue,
	onSaved,
	savedAt,
	showToc,
	sectionIdPrefix,
	fieldIdPrefix,
	scrollHost,
	scrollHostVersion,
}: {
	tabKey: string
	pluginName: string
	schema: ObjectSchema<any, any>
	savedValue: Record<string, any>
	defaultValue: Record<string, any>
	onSaved: (k: string) => void
	savedAt?: number
	showToc?: boolean
	sectionIdPrefix?: string
	fieldIdPrefix?: string
	scrollHost?: HTMLElement | null
	scrollHostVersion?: number
}) {
	const notify = useNotify()
	const sectionAnchorPrefix = useMemo(
		() => sectionIdPrefix ?? makeSectionAnchorPrefix(pluginName, tabKey),
		[pluginName, sectionIdPrefix, tabKey],
	)
	const fieldAnchorPrefix = useMemo(
		() => fieldIdPrefix ?? makeFieldAnchorPrefix(pluginName, tabKey),
		[fieldIdPrefix, pluginName, tabKey],
	)

	const initialValue = useMemo(() => ({ ...defaultValue, ...savedValue }), [defaultValue, savedValue])

	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: initialValue,
				onSubmit: async ({ value, formApi }) => {
					using rpc = createRpcClient()
					const result = await rpc.plugin(pluginName).saveConfig({ [tabKey]: value })
					if (result.ok === false) {
						if (result.code === 'validation_failed' && result.errors) {
							const fieldErrors = result.errors[tabKey]
							if (fieldErrors) {
								for (const [fieldName, issues] of Object.entries(fieldErrors)) {
									if (fieldName === '_root' || fieldName === '_unknown') continue
									formApi.setFieldMeta(fieldName as any, (meta) => ({
										...meta,
										errorMap: {
											...meta.errorMap,
											onSubmit: {
												message: issues.map((i) => i.message).join('; '),
												dotPath: issues[0]?.path ?? [],
											},
										},
									}))
								}
							}
						}
						notify({
							title: '提交失败',
							message: result.message ?? result.code ?? '未知错误',
							color: 'red',
						})
						return
					}
					onSaved(tabKey)
					notify({ title: '提交成功', message: `配置 ${tabKey} 已保存`, color: 'green' })
				},
			}),
		[tabKey, initialValue, onSaved, notify, pluginName],
	)

	const hotkeys = useMemo(
		(): [string, (e: KeyboardEvent) => void][] => [
			[
				'mod+S',
				(e) => {
					e.preventDefault()
					document.getElementById(`submit-fab-${tabKey}`)?.click()
				},
			],
			['Escape', () => document.getElementById(`cancel-fab-${tabKey}`)?.click()],
		],
		[tabKey],
	)
	useHotkeys(hotkeys)

	return (
		<AutoForm key={`${pluginName}-${tabKey}`} schema={schema as any} formOpts={opts}>
			{showToc ? (
				<FormToc
					sectionIdPrefix={sectionAnchorPrefix}
					fieldIdPrefix={fieldAnchorPrefix}
					scrollHost={scrollHost}
					scrollHostVersion={scrollHostVersion ?? 0}
				/>
			) : null}
			<Box px="sm" pb={96} style={{ position: 'relative' }}>
				<AutoForm.Fields sectionIdPrefix={sectionAnchorPrefix} fieldIdPrefix={fieldAnchorPrefix} />
			</Box>
			<AutoForm.Actions>
				{({ submit, reset, dirty, canSubmit, submitting }) => (
					<FloatingBar
						title={tabKey}
						dirty={dirty}
						canSubmit={canSubmit}
						submitting={submitting}
						onSubmit={submit}
						onCancel={() => reset(initialValue)}
						onResetToDefaults={() => reset(defaultValue)}
						savedAt={savedAt}
					/>
				)}
			</AutoForm.Actions>
		</AutoForm>
	)
}

export function ConfigTabPanel(props: Parameters<typeof ConfigTabContent>[0]) {
	return (
		<Tabs.Panel
			value={props.tabKey}
			pt="md"
			style={{
				flex: 1,
				minHeight: 0,
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		>
			<ConfigTabContent {...props} />
		</Tabs.Panel>
	)
}
