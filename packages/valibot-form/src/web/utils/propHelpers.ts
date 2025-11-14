/**
 * Props 处理工具函数
 * 用于简化组件 props 传递，避免 exactOptionalPropertyTypes 带来的冗余语法
 */

/**
 * 清理对象中的 undefined 值
 * 这样可以安全地传递给 Mantine 组件，避免 exactOptionalPropertyTypes 错误
 */
export function cleanProps<T extends Record<string, any>>(props: T): any {
	const result: any = {}
	for (const [key, value] of Object.entries(props)) {
		if (value !== undefined) {
			result[key] = value
		}
	}
	return result
}

/**
 * 从事件中提取值
 */
export function getEventValue<T extends HTMLElement>(
	event: React.ChangeEvent<T> | React.FocusEvent<T>,
	key: 'value' | 'checked' = 'value',
): any {
	return (event.currentTarget as any)[key]
}

/**
 * 构建控件的通用 props（自动处理 undefined）
 */
export function getControlProps(inputProps: { disabled?: boolean; readOnly?: boolean }): any {
	return cleanProps({
		disabled: inputProps.disabled,
		readOnly: inputProps.readOnly,
	})
}

/**
 * 智能构建任意组件的 props，自动合并多个对象并过滤 undefined
 * 让使用方完全不需要条件扩展
 */
export function buildProps<T extends Record<string, any>>(
	...sources: (T | undefined | null)[]
): any {
	const merged: any = {}
	for (const source of sources) {
		if (source) {
			Object.assign(merged, source)
		}
	}
	return cleanProps(merged)
}

/**
 * 构建 Mantine 输入组件的通用 props
 * 包含 placeholder, disabled, readOnly 等常用属性
 */
export function buildInputProps(config: {
	placeholder?: string
	disabled?: boolean
	readOnly?: boolean
	min?: number
	max?: number
	step?: number
	leftSection?: React.ReactNode
	rightSection?: React.ReactNode
	[key: string]: any
}): any {
	return cleanProps(config)
}
