import { Divider, Stack, Text } from '@mantine/core'
import React, { createContext, memo, Suspense, useCallback, useContext, useMemo } from 'react'
import type { ObjectLikeSchema } from 'valibot'
import { DEFAULT_TEXTS } from '~/core/constants'
import { MetaRenderer } from '~/core/registry'
import { useAppForm } from './formContext'
import { planSchemaFields, type PlannedField, type SectionPlan } from './fieldPlanner'
import { alignToCss, resolveFieldSpan } from './layout'
import { renderersRegistered } from './registerRenderers'

// -------- Context（暴露同一表单实例与渲染数据） ----------
interface Ctx<S extends ObjectLikeSchema> {
	form: ReturnType<typeof useAppForm<S>>
	sections: SectionPlan[]
	hiddenFields: PlannedField[]
	defaultValues: Record<string, unknown>
	submit: () => void
	reset: (values?: Record<string, any>) => void
}
const AutoFormCtx = createContext<Ctx<ObjectLikeSchema> | null>(null)

export function useAutoFormCtx<S extends ObjectLikeSchema>() {
	const ctx = useContext(AutoFormCtx)
	if (!ctx) {
		throw new Error(DEFAULT_TEXTS.errors.autoFormContextMissing)
	}
	return ctx as Ctx<S>
}

export interface AutoFormProps<S extends ObjectLikeSchema> {
	schema: S
	/** 建议用 useMemo 包装后传入 */
	formOpts?: Parameters<typeof useAppForm<S>>[1]
	/** 你自由摆放内容：标题/按钮/字段/调试等 */
	children: React.ReactNode
}

export function AutoForm<S extends ObjectLikeSchema>({
	schema,
	formOpts,
	children,
}: AutoFormProps<S>) {
	// Force registerRenderers module to stay in the bundle
	void renderersRegistered

	const form = useAppForm(schema, formOpts)

	const fieldPlan = useMemo(() => planSchemaFields(schema), [schema])

	const ctx = useMemo<Ctx<S>>(
		() => ({
			form,
			sections: fieldPlan.sections,
			hiddenFields: fieldPlan.hiddenFields,
			defaultValues: (form.options.defaultValues ?? {}) as Record<string, unknown>,
			submit: () => form.handleSubmit(),
			reset: (values?: Record<string, any>) => form.reset(values as any),
		}),
		[form, fieldPlan],
	)

	const onSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault()
			form.handleSubmit()
		},
		[form],
	)

	// 用 <form> 包住所有插槽（标题/按钮/字段），确保是同一个实例
	return (
		<form onSubmit={onSubmit}>
			<AutoFormCtx.Provider value={ctx}>{children}</AutoFormCtx.Provider>
		</form>
	)
}

/* ───────── 子组件：字段渲染（字段级订阅，低重渲染） ───────── */
export interface AutoFormFieldsProps {
	sectionSpacing?: number | string
}

const FieldsImpl = (props?: AutoFormFieldsProps) => {
	const { sectionSpacing = 'xl' } = props ?? {}
	const { form, sections, hiddenFields, defaultValues } = useAutoFormCtx<any>()

	return (
		<>
			{hiddenFields.map(({ name }) => (
				<form.Field key={`hidden-${name}`} name={name}>
					{() => null}
				</form.Field>
			))}

			<Stack gap={sectionSpacing}>
				{sections.map((section) => (
					<SectionBlock key={section.id} section={section} form={form} defaultValues={defaultValues} />
				))}
			</Stack>
		</>
	)
}

function SectionBlock({
	section,
	form,
	defaultValues,
}: {
	section: SectionPlan
	form: ReturnType<typeof useAppForm<any>>
	defaultValues: Record<string, unknown>
}) {
	const columns = Math.max(1, section.columns ?? 1)
	const showHeader = Boolean(section.title || section.description)

	return (
		<Stack gap="sm">
			{showHeader ? (
				<Stack gap={4}>
					{section.title ? <Text fw={600}>{section.title}</Text> : null}
					{section.description ? (
						<Text size="sm" c="dimmed">
							{section.description}
						</Text>
					) : null}
					<Divider />
				</Stack>
			) : null}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
					gap: 'var(--mantine-spacing-lg)',
				}}
			>
				{section.fields.map(({ name, info }) => {
					const span = resolveFieldSpan(columns, info.formInfo.layout, info.type)
					return (
						<div
							key={name}
							style={{
								gridColumn: `span ${Math.min(span, columns)}`,
								alignSelf: alignToCss(info.formInfo.layout?.align),
							}}
						>
							<form.Field name={name}>
								{(field) => (
									<MetaRenderer
										type={info.type}
										formBaseInfo={info.formInfo}
										extractedPropsInfo={info.props}
										errors={field.state.meta.errors as any}
										value={field.state.value as any}
										defaultValue={defaultValues[name]}
										inputProps={{
											name,
											onChange: field.handleChange,
											onBlur: field.handleBlur,
											...(info.formInfo.disabled !== undefined && { disabled: info.formInfo.disabled }),
											...(info.formInfo.readOnly !== undefined && { readOnly: info.formInfo.readOnly }),
										}}
									/>
								)}
							</form.Field>
						</div>
					)
				})}
			</div>
		</Stack>
	)
}

AutoForm.Fields = memo(FieldsImpl) as React.FC<AutoFormFieldsProps>
if (process.env.NODE_ENV !== 'production') {
	AutoForm.Fields.displayName = 'AutoForm.Fields'
	AutoForm.displayName = 'AutoForm'
}

/* ───────── 子组件：动作（render-props，完全自定义外观/位置） ───────── */
export interface ActionsRenderProps {
	submit: () => void
	reset: (values?: Record<string, any>) => void
	setValues: (values: Record<string, any>) => void
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
}
export interface ActionsProps {
	children: (p: ActionsRenderProps) => React.ReactNode
}
function ActionsImpl({ children }: ActionsProps) {
	const { form, submit, reset } = useAutoFormCtx<any>()
	const setValues = useCallback((values: Record<string, any>) => {
		for (const [key, value] of Object.entries(values)) {
			form.setFieldValue(key, value)
		}
	}, [form])
	return (
		<form.Subscribe
			selector={(s) => ({
				dirty: s.isDirty,
				canSubmit: s.canSubmit,
				submitting: s.isSubmitting,
			})}
		>
			{({ dirty, canSubmit, submitting }) =>
				children({ submit, reset, setValues, dirty, canSubmit, submitting })
			}
		</form.Subscribe>
	)
}
AutoForm.Actions = ActionsImpl as React.FC<ActionsProps>
if (process.env.NODE_ENV !== 'production') {
	AutoForm.Actions.displayName = 'AutoForm.Actions'
}

/* ───────── 子组件：调试（懒加载 + 类型稳） ───────── */
const DebugValues = React.lazy(() =>
	import('./DebugValues').then((m) => ({ default: m.DebugValues })),
)
function DebugPanelImpl() {
	const { form } = useAutoFormCtx<any>()
	const isDev = (() => {
		if (typeof process !== 'undefined' && process.env?.NODE_ENV) {
			return process.env.NODE_ENV !== 'production'
		}
		if (typeof globalThis !== 'undefined' && (globalThis as any).__DEV__ !== undefined) {
			return Boolean((globalThis as any).__DEV__)
		}
		return true
	})()
	if (!isDev) return null
	return (
		<form.Subscribe
			selector={(s) => ({
				values: s.values,
				errorMap: s.errorMap,
				errors: s.errors,
			})}
		>
			{({ values, errorMap, errors }) => (
				<Suspense fallback={null}>
					<DebugValues formValues={{ values, errorMap, errors }} />
				</Suspense>
			)}
		</form.Subscribe>
	)
}
AutoForm.DebugPanel = DebugPanelImpl
