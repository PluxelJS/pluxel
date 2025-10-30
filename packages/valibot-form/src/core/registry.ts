// registry.core.ts

import type { PicklistOptions } from 'valibot'
import type { ExtractedProps, FormBaseInfo } from './extract'
import type { ExtractMap } from './utils'

// 只有实现 extract 的才会被 MetaRender 需要。
type PartialMetaType = keyof ExtractMap
/** 根据 MetaType 选择额外 props 的映射 */
interface ExtraPropsMap {
	string: { value: string }
	number: { value: number }
	boolean: { value: boolean }
	picklist: { value: PicklistOptions }
	array: { value: unknown[] }
	/** 补齐 record 的值类型 */
	record: { value: Record<string, unknown> }
}

/** 表单输入的基础事件 props */
export interface InputProps {
	name: string
	ref?: any
	onBlur?: any
	onChange?: (e: any) => void
}

/** 触发 change/blur 的工具函数 */
export function triggerFormEvents<T>(props: InputProps, value: T) {
	const { name, onChange, onBlur } = props
	const event = {
		target: { name, value },
		currentTarget: { name, value },
	} as const

	onChange?.(value)
	onBlur?.({ target: { name } })
}

/** 根据 MetaType 决定额外 props */
type ExtraProps<T extends PartialMetaType> = ExtraPropsMap[T]

/**
 * 通用渲染器 props：
 * - 一定要包含 type 字段，方便运行时取 renderer
 */
export type CommonProps<T extends PartialMetaType> = {
	type: T
	formBaseInfo: FormBaseInfo
	extractedPropsInfo: ExtractedProps<T>
	errors?: { message: string; dotPath: string[] }[]
	inputProps: InputProps
} & ExtraProps<T>

/** 渲染器签名：把 props 映射成「框架无关」的节点描述 */
export type Renderer<T extends PartialMetaType> = (props: CommonProps<T>) => any

/** 存储所有渲染器 */
const renderers = new Map<PartialMetaType, Renderer<PartialMetaType>>()

/** 注册渲染器 */
export function registerRenderer<T extends PartialMetaType>(type: T, renderer: Renderer<T>) {
	renderers.set(type, renderer as Renderer<PartialMetaType>)
}

/** 最终调用：根据 props.type 找到对应的 renderer */
export function MetaRenderer<T extends PartialMetaType>(props: CommonProps<T>) {
	const fn = renderers.get(props.type)
	if (!fn) throw new Error(`未注册渲染器: ${props.type}`)
	// 这里用 any 抹平泛型，运行时已有类型保护
	return fn(props as any)
}
