import React from 'react'
import {
	createContext,
	useContext,
	useMemo,
	useCallback,
	memo,
	Suspense,
} from 'react'
import { Stack, Card } from '@mantine/core'
import type { InferOutput, ObjectSchema } from 'valibot'
import { MetaRenderer, extractInfo } from 'valibot-form'
import { useAppForm } from './formContext'

// -------- schema 解析缓存，避免重复 extractInfo ----------
const infoCache = new WeakMap<object, ReturnType<typeof extractInfo> | null>()
function cachedExtractInfo(schema: object, title: string) {
	const c = infoCache.get(schema)
	if (c !== undefined) return c
	const i = extractInfo(schema as any, { title })
	infoCache.set(schema, i)
	return i
}

// -------- Context（暴露同一表单实例与渲染数据） ----------
interface Ctx<S extends ObjectSchema<any, any>> {
	form: ReturnType<typeof useAppForm<S>>
	items: Array<{
		name: string
		info: NonNullable<ReturnType<typeof extractInfo>>
	}>
	submit: () => void
	reset: () => void
}
const AutoFormCtx = createContext<Ctx<any> | null>(null)

export function useAutoFormCtx<S extends ObjectSchema<any, any>>() {
	const ctx = useContext(AutoFormCtx)
	if (!ctx) throw new Error('AutoForm.* must be used within <AutoForm>')
	return ctx as Ctx<S>
}

export interface AutoFormProps<S extends ObjectSchema<any, any>> {
	schema: S
	/** 建议用 useMemo 包装后传入 */
	formOpts?: Parameters<typeof useAppForm<S>>[1]
	/** 你自由摆放内容：标题/按钮/字段/调试等 */
	children: React.ReactNode
}

export function AutoForm<S extends ObjectSchema<any, any>>({
	schema,
	formOpts,
	children,
}: AutoFormProps<S>) {
	const form = useAppForm(schema, formOpts)

	const items = useMemo(() => {
		const entries = Object.entries(schema.entries) as [
			keyof InferOutput<S>,
			any,
		][]
		const out: Array<{
			name: string
			info: NonNullable<ReturnType<typeof extractInfo>>
		}> = []
		for (const [key, sub] of entries) {
			if (sub?.kind !== 'schema') continue
			const info = cachedExtractInfo(sub, String(key))
			if (info) out.push({ name: String(key), info })
		}
		return out
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
function FieldsImpl() {
	const { form, items } = useAutoFormCtx<any>()
	return (
		<Stack gap="md" style={{ padding: 24 }}>
			{items.map(({ name, info }) => (
				<form.Field key={name} name={name}>
					{(field) => {
						return (
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
								}}
							/>
						)
					}}
				</form.Field>
			))}
		</Stack>
	)
}
AutoForm.Fields = memo(FieldsImpl)

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
AutoForm.Actions = ActionsImpl

/* ───────── 子组件：调试（懒加载 + 类型稳） ───────── */
const DebugValues = React.lazy(() =>
	import('./DebugValues').then((m) => ({ default: m.DebugValues })),
)
function DebugPanelImpl() {
	const { form } = useAutoFormCtx<any>()
	const isDev = import.meta.env?.DEV || process.env.NODE_ENV === 'development'
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
