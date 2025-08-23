// string/type.ts
import type { fmtKey } from './stringExtractor'

export interface StringCheck {
	minLength?: number
	maxLength?: number
	pattern?: string
	enum?: string[]
	format?: fmtKey
}

export type StringMetaOptions = StringCheck & {
	/** 设为 true 时，不在明文中暴露 */
	secret?: true
	/** 设为 true 时，可在 UI 展示“复制”按钮 */
	copyable?: true
	/** 给输入框的 placeholder */
	placeholder?: string
}
