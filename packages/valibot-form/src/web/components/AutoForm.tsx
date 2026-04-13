import { Divider, Stack, Text } from '@mantine/core'
import { useElementSize, useMediaQuery } from '@mantine/hooks'
import React, {
	createContext,
	memo,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useMemo,
} from 'react'
import { getDefaults } from 'valibot'
import type { ObjectLikeSchema } from '../../core'
import { DEFAULT_SECTION_ID, DEFAULT_TEXTS } from '../../core/constants'
import { type PlannedField, planSchemaFields, type SectionPlan } from './internal/fieldPlanner'
import { useAppForm } from './internal/formContext'
import { alignToCss, resolveFieldSpan } from './internal/layout'
import { FieldRenderer } from './internal/FieldRenderer'
import { FieldRendererProvider } from './internal/fieldRendererContext'

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
	/** 外部决定何时重置表单（比如 schema 切换） */
	resetKey?: string | number
	/** 传入 form 标签的自定义属性 */
	formProps?: Omit<React.ComponentPropsWithoutRef<'form'>, 'onSubmit'>
}

export function AutoForm<S extends ObjectLikeSchema>({
	schema,
	formOpts,
	children,
	resetKey,
	formProps,
}: AutoFormProps<S>) {
	const form = useAppForm(schema, formOpts)
	const defaultValues = useMemo(
		() => (formOpts?.defaultValues ?? getDefaults(schema)) as Record<string, unknown>,
		[schema, formOpts?.defaultValues],
	)

	const fieldPlan = useMemo(() => planSchemaFields(schema), [schema])

	const ctx = useMemo<Ctx<S>>(
		() => ({
			form,
			sections: fieldPlan.sections,
			hiddenFields: fieldPlan.hiddenFields,
			defaultValues,
			submit: () => form.handleSubmit(),
			reset: (values?: Record<string, any>) => form.reset(values as any),
		}),
		[form, fieldPlan, defaultValues],
	)

	useEffect(() => {
		if (resetKey === undefined) return
		form.reset(defaultValues as any)
	}, [form, resetKey, defaultValues])

	const onSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault()
			form.handleSubmit()
		},
		[form],
	)

	// 用 <form> 包住所有插槽（标题/按钮/字段），确保是同一个实例
	return (
		<form {...formProps} onSubmit={onSubmit}>
			<AutoFormCtx.Provider value={ctx}>
				<FieldRendererProvider value={FieldRenderer}>{children}</FieldRendererProvider>
			</AutoFormCtx.Provider>
		</form>
	)
}

/* ───────── 子组件：字段渲染（字段级订阅，低重渲染） ───────── */
export interface AutoFormFieldsProps {
	sectionSpacing?: number | string
	/** 给每个 section 生成 DOM id，方便外部导航 */
	sectionIdPrefix?: string
	/** 给字段容器生成 DOM id，支持 TOC 滚动定位 */
	fieldIdPrefix?: string
}

const FieldsImpl = (props?: AutoFormFieldsProps) => {
	const { sectionSpacing = 'xl', sectionIdPrefix, fieldIdPrefix } = props ?? {}
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
					<SectionBlock
						key={section.id}
						section={section}
						form={form}
						defaultValues={defaultValues}
						sectionIdPrefix={sectionIdPrefix}
						fieldIdPrefix={fieldIdPrefix}
					/>
				))}
			</Stack>
		</>
	)
}

function toDomSlug(value: string) {
	return (
		value
			.toLowerCase()
			.replaceAll(/[^a-z0-9_-]+/gi, '-')
			.replaceAll(/^-+|-+$/g, '') || 'section'
	)
}

function SectionBlock({
	section,
	form,
	defaultValues,
	sectionIdPrefix,
	fieldIdPrefix,
}: {
	section: SectionPlan
	form: ReturnType<typeof useAppForm<any>>
	defaultValues: Record<string, unknown>
	sectionIdPrefix?: string
	fieldIdPrefix?: string
}) {
	const { ref, width } = useElementSize()
	const isNarrowViewport = useMediaQuery('(max-width: 1500px)')
	const baseColumns = Math.max(1, section.columns ?? 1)
	const responsiveColumns = useMemo(() => {
		const minColWidth = 720 // px, 更早切换为较少列，提升窄屏可读性
		if (!width) return isNarrowViewport ? 1 : baseColumns
		const fit = Math.max(1, Math.floor(width / minColWidth))
		const computed = Math.min(baseColumns, fit || 1)
		return isNarrowViewport ? Math.min(computed, 1) : computed
	}, [width, baseColumns, isNarrowViewport])
	const showHeader = Boolean(section.title || section.description)
	const domId =
		section.id === DEFAULT_SECTION_ID
			? undefined
			: sectionIdPrefix
				? `${sectionIdPrefix}${toDomSlug(section.id)}`
				: undefined
	const isAnchorVisible = Boolean(domId)

	return (
		<Stack
			gap="sm"
			id={domId}
			data-section-id={section.id}
			{...(isAnchorVisible && {
				'data-config-anchor': true,
				'data-config-anchor-depth': 1,
				'data-config-anchor-label': section.title ?? section.id,
			})}
			style={{ scrollMarginTop: '72px' }}
		>
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
				ref={ref}
				style={{
					display: 'grid',
					gridTemplateColumns: `repeat(${responsiveColumns}, minmax(0, 1fr))`,
					gap: 'var(--mantine-spacing-lg)',
				}}
			>
				{section.fields.map(({ name, node }) => {
					const span = resolveFieldSpan(responsiveColumns, node.meta.layout, node.kind)
					const fieldDomId = fieldIdPrefix ? `${fieldIdPrefix}${toDomSlug(name)}` : undefined
					return (
						<div
							key={name}
							style={{
								gridColumn: `span ${Math.min(span, responsiveColumns)}`,
								alignSelf: alignToCss(node.meta.layout?.align),
								scrollMarginTop: '72px',
							}}
							id={fieldDomId}
							data-config-anchor
							data-config-anchor-depth={2}
							data-config-anchor-label={node.meta.label ?? name}
							data-config-anchor-field-id={fieldDomId}
						>
							<form.Field name={name}>
								{(field) => (
									<FieldRenderer
										node={node}
										value={field.state.value as any}
										errors={field.state.meta.errors as any}
										defaultValue={defaultValues[name]}
										inputProps={{
											name,
											onChange: field.handleChange,
											onBlur: field.handleBlur,
											...(node.meta.disabled !== undefined && {
												disabled: node.meta.disabled,
											}),
											...(node.meta.readOnly !== undefined && {
												readOnly: node.meta.readOnly,
											}),
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
	const setValues = useCallback(
		(values: Record<string, any>) => {
			for (const [key, value] of Object.entries(values)) {
				form.setFieldValue(key, value)
			}
		},
		[form],
	)
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
	import('./debug/DebugValues').then((m) => ({ default: m.DebugValues })),
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

export interface DebugPanelProps {}
AutoForm.DebugPanel = DebugPanelImpl as React.FC<DebugPanelProps>
if (process.env.NODE_ENV !== 'production') {
	AutoForm.DebugPanel.displayName = 'AutoForm.DebugPanel'
}
