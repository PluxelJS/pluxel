import { Box } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { formOptions } from '@tanstack/react-form'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'
import { useNotify } from '../../hooks'
import { useRuntimeTransportClient } from '../../../runtime'
import { FormToc } from './components/FormToc'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'

export type ConfigFormState = {
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
	values: Record<string, any>
}

export type ConfigFormBridge = {
	form: any
	reset: (values?: Record<string, any>, opts?: { keepDefaultValues?: boolean }) => void
	submit: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i += 1) {
			if (!deepEqual(a[i], b[i])) return false
		}
		return true
	}
	if (isRecord(a) && isRecord(b)) {
		const aKeys = Object.keys(a)
		const bKeys = Object.keys(b)
		if (aKeys.length !== bKeys.length) return false
		for (const key of aKeys) {
			if (!(key in b)) return false
			if (!deepEqual(a[key], b[key])) return false
		}
		return true
	}
	return false
}

type SaveConfigFailure = {
	ok: false
	code?: string
	message?: string
	errors?: Record<string, Record<string, Array<{ message: string; path: string[] }>>>
}

type SaveConfigSuccess = {
	ok: true
	config?: Record<string, unknown>
	defaults?: Record<string, unknown>
	saved?: boolean
}

type SaveConfigResult = SaveConfigFailure | SaveConfigSuccess

export function ConfigTabContent({
	pluginName,
	tabKey,
	schema,
	savedValue,
	defaultValue,
	draftValue,
	onSaved,
	showToc,
	active = true,
	sectionIdPrefix,
	fieldIdPrefix,
	scrollHost,
	scrollHostVersion,
	registerForm,
	reportState,
}: {
	tabKey: string
	pluginName: string
	schema: ObjectSchema<any, any>
	savedValue: Record<string, any>
	defaultValue: Record<string, any>
	draftValue?: Record<string, any>
	onSaved: (k: string, value: Record<string, any>) => void
	showToc?: boolean
	active?: boolean
	sectionIdPrefix?: string
	fieldIdPrefix?: string
	scrollHost?: HTMLElement | null
	scrollHostVersion?: number
	registerForm?: (key: string, api: ConfigFormBridge) => void | (() => void)
	reportState?: (key: string, state: ConfigFormState) => void
}) {
	const notify = useNotify()
	const transport = useRuntimeTransportClient()
	const sectionAnchorPrefix = useMemo(
		() => sectionIdPrefix ?? makeSectionAnchorPrefix(pluginName, tabKey),
		[pluginName, sectionIdPrefix, tabKey],
	)
	const fieldAnchorPrefix = useMemo(
		() => fieldIdPrefix ?? makeFieldAnchorPrefix(pluginName, tabKey),
		[fieldIdPrefix, pluginName, tabKey],
	)
	const [initialDraftValue] = useState(() => draftValue)

	const initialValue = useMemo(
		() => ({ ...defaultValue, ...savedValue }),
		[defaultValue, savedValue],
	)

	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: initialValue,
				onSubmit: async ({ value, formApi }) => {
					const result = (await (transport as any).withRpc((rpc: any) =>
						rpc.plugin(pluginName).saveConfig({ [tabKey]: value }),
					)) as SaveConfigResult
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
					formApi.reset(value as any)
					onSaved(tabKey, value as any)
					notify({ title: '提交成功', message: `配置 ${tabKey} 已保存`, color: 'green' })
				},
			}),
		[transport, tabKey, initialValue, onSaved, notify, pluginName],
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
			{registerForm ? <FormBridge tabKey={tabKey} registerForm={registerForm} /> : null}
			{initialDraftValue ? <FormDraftRestore draftValue={initialDraftValue} /> : null}
			{reportState ? <FormStateSlot tabKey={tabKey} reportState={reportState} /> : null}
			{active ? <FormHotkeys active={active} initialValue={initialValue} /> : null}
			<Box
				style={{
					minWidth: 0,
				}}
			>
				<Box px="xs" pb={24} style={{ position: 'relative' }}>
					<AutoForm.Fields
						sectionIdPrefix={sectionAnchorPrefix}
						fieldIdPrefix={fieldAnchorPrefix}
					/>
				</Box>
				{showToc ? (
					<FormToc
						sectionIdPrefix={sectionAnchorPrefix}
						fieldIdPrefix={fieldAnchorPrefix}
						scrollHost={scrollHost}
						scrollHostVersion={scrollHostVersion ?? 0}
					/>
				) : null}
			</Box>
		</AutoForm>
	)
}

function FormBridge({
	tabKey,
	registerForm,
}: {
	tabKey: string
	registerForm: (key: string, api: ConfigFormBridge) => void | (() => void)
}): null {
	const { form, reset, submit } = useAutoFormCtx<any>()

	useEffect(() => {
		const disposer = registerForm(tabKey, { form, reset, submit })
		return () => {
			if (typeof disposer === 'function') disposer()
		}
	}, [form, registerForm, reset, tabKey])

	return null
}

function FormDraftRestore({ draftValue }: { draftValue: Record<string, any> }): null {
	const { form, reset } = useAutoFormCtx<any>()
	const restoredDraftRef = useRef(false)

	useEffect(() => {
		if (!draftValue || Object.keys(draftValue).length === 0) {
			restoredDraftRef.current = false
			return
		}
		if (restoredDraftRef.current || form.state.isDirty) return
		restoredDraftRef.current = true
		reset(draftValue)
	}, [draftValue, form.state.isDirty, reset])

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
			selector={(s: any) => ({
				dirty: s.isDirty,
				canSubmit: s.canSubmit,
				submitting: s.isSubmitting,
				values: s.values,
			})}
		>
			{(state) => <FormStateReporter tabKey={tabKey} state={state} reportState={reportState} />}
		</form.Subscribe>
	)
}

function FormStateReporter({
	tabKey,
	state,
	reportState,
}: {
	tabKey: string
	state: ConfigFormState
	reportState: (key: string, state: ConfigFormState) => void
}): null {
	const lastStateRef = useRef<ConfigFormState | null>(null)

	useEffect(() => {
		const previous = lastStateRef.current
		if (
			previous &&
			previous.dirty === state.dirty &&
			previous.canSubmit === state.canSubmit &&
			previous.submitting === state.submitting &&
			deepEqual(previous.values, state.values)
		) {
			return
		}
		lastStateRef.current = state
		reportState(tabKey, state)
	}, [reportState, state, tabKey])

	return null
}

function FormHotkeys({
	active,
	initialValue,
}: {
	active: boolean
	initialValue: Record<string, any>
}): null {
	const { submit, reset } = useAutoFormCtx<any>()
	const hotkeys = useMemo(
		(): Parameters<typeof useHotkeys>[0] =>
			active
				? [
						[
							'mod+S',
							(e: KeyboardEvent) => {
								e.preventDefault()
								submit()
							},
						],
						[
							'Escape',
							() => {
								reset(initialValue)
							},
						],
					]
				: [],
		[active, initialValue, reset, submit],
	)
	useHotkeys(hotkeys)

	return null
}

export function ConfigTabPanel(props: Parameters<typeof ConfigTabContent>[0]) {
	return (
		<Box
			pt="xs"
			style={{
				flex: 1,
				minHeight: 0,
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		>
			<ConfigTabContent {...props} />
		</Box>
	)
}
