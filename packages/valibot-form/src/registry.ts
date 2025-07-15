// registry.core.ts
import type { PicklistOptions } from 'valibot'
import type { FormInfo } from './extract'
import type { MetaType } from './utils/MetaType'

interface ExtraPropsMap {
	string: { value: string }
	number: { value: number }
	boolean: { value: boolean }
	picklist: { value: PicklistOptions }
	form: {}
	object: {}
}

export interface InputProps {
	name: string
	ref?: any
	onBlur?: any
	onChange: any
}
export function triggerFormEvents<T>(props: InputProps, value: T) {
	const { name, onChange, onBlur } = props
	const event = {
		target: { name, value },
		currentTarget: { name, value },
	} as const

	onChange?.(event)
	onBlur?.({ target: { name } })
}

type ExtraProps<T extends MetaType.Name> = ExtraPropsMap[T]

export type CommonProps<T extends MetaType.Name> = {
	type: T
	options: MetaType.Return<T>
	error?: string
	formInfo: FormInfo
	inputProps: InputProps
} & ExtraProps<T>

// 渲染器签名：只负责把 props 映射成一个“框架无关”的节点描述
export type Renderer<T extends MetaType.Name> = (props: CommonProps<T>) => any

const renderers = new Map<MetaType.Name, Renderer<MetaType.Name>>()

export function registerRenderer<T extends MetaType.Name>(
	type: T,
	renderer: Renderer<T>,
) {
	renderers.set(type, renderer as Renderer<MetaType.Name>)
}

// 暴露给平台层去调用
export function MetaRenderer<T extends MetaType.Name>(props: CommonProps<T>) {
	const fn = renderers.get(props.type)
	if (!fn) throw new Error(`未注册渲染器: ${props.type}`)
	return fn(props as any) // any 上抹平泛型
}
