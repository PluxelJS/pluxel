import type React from 'react'
import { useMemo, useRef } from 'react'
import { Stack, Text, Select } from '@mantine/core'
import { META_MAP, registerRenderer, triggerFormEvents } from 'valibot-form'

/* --------------------------- Types (精简+) --------------------------- */
export type PicklistUI<T extends string | number = string | number> = {
	options: readonly T[]
	labels?: Partial<Record<T, string>>
	placeholder?: string
	/** 若未提供，将走“聪明默认” */
	searchable?: true
	clearable?: true
}

type RendererProps = {
	formBaseInfo?: { title?: string; required?: boolean }
	errors?: { message: string; dotPath: string[] }[]
	extractedPropsInfo?: PicklistUI<string | number>
	inputProps: {
		name?: string
		onChange?: (v: unknown) => void
		onBlur?: (evt?: any) => void
		disabled?: boolean
	}
	value?: unknown // 单选=字面量或 null；多选=数组
}

/* ------------------------------ Utils ------------------------------ */
const idOf = (v: string | number) => String(v)

function useData(
	opts: readonly (string | number)[],
	labels?: Partial<Record<string | number, string>>,
	disabled?: readonly (string | number)[],
) {
	const idToRawRef = useRef(new Map<string, string | number>())
	const { data, isAllNumbers } = useMemo(() => {
		const disabledSet = new Set((disabled ?? []).map((v) => String(v)))
		const arr = (opts ?? []).map((raw) => {
			const id = idOf(raw)
			idToRawRef.current.set(id, raw)
			return {
				value: id,
				label: (labels as any)?.[raw] ?? String(raw),
				disabled: disabledSet.has(id),
			}
		})
		const allNums =
			(opts ?? []).length > 0 &&
			(opts ?? []).every((x) => typeof x === 'number')
		return { data: arr, isAllNumbers: allNums }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [opts, labels, disabled])
	return { data, idToRawRef, isAllNumbers }
}

/* ----------------------------- Renderer ---------------------------- */
function PicklistRenderer(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const ep = {
		...extractedPropsInfo,
	} as PicklistUI<string | number>

	// 标题
	const title = (
		<Text fw={500}>
			{formBaseInfo?.title}
			{formBaseInfo?.required ? ' *' : ''}
		</Text>
	)

	// 仅聚合本字段错误
	const errorText = useMemo(() => {
		const field = inputProps?.name
		return (errors ?? [])
			.filter((e) => (field ? e.dotPath?.[0] === field : true))
			.map((e) => e.message)
			.join(', ')
	}, [errors, inputProps?.name])

	// 归一化选项 + 映射
	const { data, idToRawRef, isAllNumbers } = useData(
		ep.options ?? [],
		ep.labels,
	)

	// 当前值 -> id（非受控：仅 defaultValue）
	const currentIds = useMemo(() => {
		return value == null ? null : idOf(value as any)
	}, [value])

	// “聪明默认”
	const optionCount = (ep.options ?? []).length
	const autoSearchable = ep.searchable ?? optionCount >= 8
	const autoClearable = ep.clearable ?? !formBaseInfo?.required

	// 写回（id -> 原始类型）
	const commitSingle = (id: string | null) => {
		if (id === null) return triggerFormEvents(inputProps as any, null)
		const raw = idToRawRef.current.get(id)
		triggerFormEvents(
			inputProps as any,
			raw ?? (isAllNumbers ? Number(id) : id),
		)
	}

	// 包裹
	const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
		<Stack gap="xs">
			{title}
			{children}
		</Stack>
	)
	// —— 单选：Select —— //
	return (
		<Wrapper>
			<Select
				{...(inputProps as any)}
				data={data}
				defaultValue={currentIds ?? undefined}
				onChange={(id) => commitSingle(id)}
				searchable={autoSearchable}
				clearable={autoClearable}
				error={errorText}
				placeholder={ep.placeholder}
				// Select 在 v8 中通常不使用 maxValues/limit，这里不传避免多余 DOM props
				nothingFoundMessage={autoSearchable ? '无匹配项' : undefined}
			/>
		</Wrapper>
	)
}

/* ---------------------------- Register ---------------------------- */
registerRenderer(META_MAP.PICKLIST, (props: RendererProps) => (
	<PicklistRenderer {...props} />
))
