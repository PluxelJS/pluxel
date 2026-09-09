import { Divider, Stack, Text } from '@mantine/core'
import { useElementSize, useMediaQuery } from '@mantine/hooks'
import React, { memo, Suspense, useCallback, useEffect, useMemo } from 'react'
import { getDefaults, type InferOutput } from 'valibot'
import type { ObjectLikeSchema } from '../../core'
import type { FieldNode } from '../../core/fields'
import { DEFAULT_SECTION_ID } from '../../core/constants'
import { isDevelopmentEnvironment } from '../../core/utils/environment'
import { planFieldSections, planSchemaFields, type SectionPlan } from './internal/fieldPlanner'
import { AutoFormCtx, FormResetVersion, useAutoFormCtx, useAppForm } from './internal/formContext'
import { alignToCss, resolveFieldSpan } from './internal/layout'
import { BoundField } from './internal/BoundField'
import { FieldRenderer } from './internal/FieldRenderer'
import { FieldRendererProvider } from './internal/fieldRendererContext'

export { useAutoFormCtx } from './internal/formContext'

type AutoFormSharedProps = {
	/** 你自由摆放内容：标题/按钮/字段/调试等 */
	children: React.ReactNode
	/** 外部决定何时重置表单（比如 schema 切换） */
	resetKey?: string | number
	/** 传入 form 标签的自定义属性 */
	formProps?: Omit<React.ComponentPropsWithoutRef<'form'>, 'onSubmit'>
}

export type AutoFormSchemaProps<S extends ObjectLikeSchema> = AutoFormSharedProps & {
	schema: S
	fields?: never
	/** 建议用 useMemo 包装后传入 */
	formOpts?: Parameters<typeof useAppForm<InferOutput<S>>>[1]
}

export type AutoFormPlanProps<TValues extends Record<string, unknown>> = AutoFormSharedProps & {
	schema?: never
	/** Browser-safe renderer plan; plan mode never claims schema-derived output inference. */
	fields: readonly FieldNode[]
	formOpts: { defaultValues: TValues } & Record<string, unknown>
}

export type AutoFormProps<
	S extends ObjectLikeSchema,
	TValues extends Record<string, unknown> = InferOutput<S> & Record<string, unknown>,
> = AutoFormSchemaProps<S> | AutoFormPlanProps<TValues>

export function AutoForm<S extends ObjectLikeSchema>(
	props: AutoFormSchemaProps<S>,
): React.ReactElement
export function AutoForm<TValues extends Record<string, unknown>>(
	props: AutoFormPlanProps<TValues>,
): React.ReactElement
export function AutoForm<
	S extends ObjectLikeSchema,
	TValues extends Record<string, unknown> = InferOutput<S> & Record<string, unknown>,
>({ schema, fields, formOpts, children, resetKey, formProps }: AutoFormProps<S, TValues>) {
	const { form, resetVersion } = useAppForm<Record<string, unknown>>(schema, formOpts)
	const defaultValues = useMemo(
		() =>
			(formOpts?.defaultValues ?? (schema === undefined ? {} : getDefaults(schema))) as Record<
				string,
				unknown
			>,
		[schema, formOpts?.defaultValues],
	)

	const fieldPlan = useMemo(() => {
		if (fields) return planFieldSections([...fields])
		if (schema) return planSchemaFields(schema)
		throw new Error('AutoForm requires either schema or fields')
	}, [fields, schema])

	const ctx = useMemo<ReturnType<typeof useAutoFormCtx>>(
		() => ({
			form,
			sections: fieldPlan.sections,
			hiddenFields: fieldPlan.hiddenFields,
			defaultValues,
			submit: () => void form.handleSubmit(),
			reset: (values?: Record<string, unknown>) => form.reset(values),
		}),
		[form, fieldPlan, defaultValues],
	)

	useEffect(() => {
		if (resetKey === undefined) return
		form.reset(defaultValues)
	}, [form, resetKey, defaultValues])

	const onSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault()
			void form.handleSubmit()
		},
		[form],
	)

	// 用 <form> 包住所有插槽（标题/按钮/字段），确保是同一个实例
	return (
		<form {...formProps} onSubmit={onSubmit}>
			<AutoFormCtx.Provider value={ctx}>
				<FormResetVersion.Provider value={resetVersion}>
					<FieldRendererProvider value={renderBoundField} renderValue={renderFieldValue}>
						{children}
					</FieldRendererProvider>
				</FormResetVersion.Provider>
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
	const { sections } = useAutoFormCtx()

	return (
		<>
			<Stack gap={sectionSpacing}>
				{sections.map((section) => (
					<SectionBlock
						key={section.id}
						section={section}
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
	sectionIdPrefix,
	fieldIdPrefix,
}: {
	section: SectionPlan
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
							<BoundField node={node} path={[name]} />
						</div>
					)
				})}
			</div>
		</Stack>
	)
}

AutoForm.Fields = memo(FieldsImpl) as React.FC<AutoFormFieldsProps>
if (isDevelopmentEnvironment()) {
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
if (isDevelopmentEnvironment()) {
	AutoForm.Actions.displayName = 'AutoForm.Actions'
}

/* ───────── 子组件：调试（懒加载 + 类型稳） ───────── */
const DebugValues = React.lazy(() =>
	import('./debug/DebugValues').then((m) => ({ default: m.DebugValues })),
)
function DebugPanelImpl() {
	const { form } = useAutoFormCtx<any>()
	if (!isDevelopmentEnvironment()) return null
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
if (isDevelopmentEnvironment()) {
	AutoForm.DebugPanel.displayName = 'AutoForm.DebugPanel'
}

function renderBoundField(props: React.ComponentProps<typeof BoundField>) {
	return <BoundField {...props} />
}
function renderFieldValue(props: React.ComponentProps<typeof FieldRenderer>) {
	return <FieldRenderer {...props} />
}
