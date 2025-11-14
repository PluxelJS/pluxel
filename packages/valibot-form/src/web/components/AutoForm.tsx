import { Card, Divider, Stack, Text } from '@mantine/core'
import React, { createContext, memo, Suspense, useCallback, useContext, useMemo } from 'react'
import type { InferOutput, ObjectLikeSchema } from 'valibot'
import { DEFAULT_GRID_COLUMNS, DEFAULT_SECTION_ID, DEFAULT_TEXTS, GRID_COLUMN_THRESHOLD } from '~/core/constants'
import { MetaRenderer } from '~/core/registry'
import { collectObjectEntries } from '~/core/utils'
import { useAppForm } from './formContext'
import { renderersRegistered } from './registerRenderers'
import { cachedExtractInfo } from './schemaCache'

// -------- Context（暴露同一表单实例与渲染数据） ----------
interface Ctx<S extends ObjectLikeSchema> {
	form: ReturnType<typeof useAppForm<S>>
	items: Array<{
		name: string
		info: NonNullable<ReturnType<typeof cachedExtractInfo>>
	}>
	submit: () => void
	reset: () => void
}
const AutoFormCtx = createContext<Ctx<ObjectLikeSchema> | null>(null)

type FieldItem = Ctx<ObjectLikeSchema>['items'][number]

interface SectionBucket {
	id: string
	title?: string
	description?: string
	columns?: number
	order?: number
	fields: FieldItem[]
}

function buildSections(items: FieldItem[]): SectionBucket[] {
	const map = new Map<string, SectionBucket>()
	for (const item of items) {
		const sectionMeta = item.info.formInfo.section
		const bucketId = sectionMeta?.id ?? DEFAULT_SECTION_ID
		if (!map.has(bucketId)) {
			const bucket: SectionBucket = {
				id: bucketId,
				fields: [],
			}
			if (sectionMeta?.title !== undefined) bucket.title = sectionMeta.title
			if (sectionMeta?.description !== undefined) bucket.description = sectionMeta.description
			if (sectionMeta?.columns !== undefined) bucket.columns = sectionMeta.columns
			if (sectionMeta?.order !== undefined) bucket.order = sectionMeta.order
			map.set(bucketId, bucket)
		}
		const bucket = map.get(bucketId)!
		if (sectionMeta?.title && !bucket.title) bucket.title = sectionMeta.title
		if (sectionMeta?.description && !bucket.description) bucket.description = sectionMeta.description
		if (sectionMeta?.columns && !bucket.columns) bucket.columns = sectionMeta.columns
		if (sectionMeta?.order && bucket.order === undefined) bucket.order = sectionMeta.order
		bucket.fields.push(item)
	}

	return Array.from(map.values()).sort((a, b) => {
		const orderA = a.order ?? 0
		const orderB = b.order ?? 0
		if (orderA !== orderB) return orderA - orderB
		return (a.title ?? '').localeCompare(b.title ?? '')
	})
}

function resolveColumns(section: SectionBucket) {
	if (section.columns && section.columns > 0) return section.columns
	if (section.fields.length >= GRID_COLUMN_THRESHOLD) return DEFAULT_GRID_COLUMNS
	return 1
}

function resolveSpan(meta: FieldItem['info']['formInfo'], columns: number) {
	if (meta.layout?.fullWidth) return columns
	if (meta.layout?.span) return Math.min(columns, Math.max(1, meta.layout.span))
	return 1
}

function alignToCss(align?: 'start' | 'center' | 'end' | 'stretch') {
	switch (align) {
		case 'center':
			return 'center'
		case 'end':
			return 'flex-end'
		case 'stretch':
			return 'stretch'
		default:
			return 'flex-start'
	}
}

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

	const items = useMemo(() => {
		const entries = collectObjectEntries(schema as any) ?? []
		const collected: Array<{
			name: string
			info: NonNullable<ReturnType<typeof cachedExtractInfo>>
		}> = []
		for (const entry of entries as { name: keyof InferOutput<S>; schema: any }[]) {
			const sub = entry.schema
			if (sub?.kind !== 'schema') continue
			const info = cachedExtractInfo(sub, String(entry.name))
			if (info) collected.push({ name: String(entry.name), info })
		}
		return collected
	}, [schema])

	const ctx = useMemo<Ctx<S>>(
		() => ({
			form,
			items,
			submit: () => form.handleSubmit(),
			reset: () => form.reset(),
		}),
		[form, items],
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
	const { form, items } = useAutoFormCtx<any>()

	const { visibleItems, hiddenItems } = useMemo(() => {
		const hidden: FieldItem[] = []
		const visible: FieldItem[] = []
		for (const item of items) {
			if (item.info.formInfo.hidden) hidden.push(item)
			else visible.push(item)
		}
		return { hiddenItems: hidden, visibleItems: visible }
	}, [items])

	const sections = useMemo(() => buildSections(visibleItems), [visibleItems])

	return (
		<>
			{hiddenItems.map(({ name }) => (
				<form.Field key={`hidden-${name}`} name={name}>
					{() => null}
				</form.Field>
			))}

			<Stack gap={sectionSpacing}>
				{sections.map((section) => (
					<SectionBlock key={section.id} section={section} form={form} />
				))}
			</Stack>
		</>
	)
}

function SectionBlock({
	section,
	form,
}: {
	section: SectionBucket
	form: ReturnType<typeof useAppForm<any>>
}) {
	const columns = resolveColumns(section)
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
					const span = resolveSpan(info.formInfo, columns)
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
	reset: () => void
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
}
export interface ActionsProps {
	children: (p: ActionsRenderProps) => React.ReactNode
}
function ActionsImpl({ children }: ActionsProps) {
	const { form, submit, reset } = useAutoFormCtx<any>()
	return (
		<form.Subscribe
			selector={(s) => ({
				dirty: s.isDirty,
				canSubmit: s.canSubmit,
				submitting: s.isSubmitting,
			})}
		>
			{({ dirty, canSubmit, submitting }) =>
				children({ submit, reset, dirty, canSubmit, submitting })
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
		<Card withBorder style={{ padding: 24 }}>
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
		</Card>
	)
}
AutoForm.DebugPanel = DebugPanelImpl
