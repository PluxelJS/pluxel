// string/type.ts
import type { fmtKey } from './stringExtractor'

/**
 * 字符串校验规则（从 valibot schema 自动提取）
 */
export interface StringCheck {
	/** 最小长度 */
	minLength?: number
	/** 最大长度 */
	maxLength?: number
	/** 正则表达式模式 */
	pattern?: string
	/** 枚举值列表 */
	enum?: string[]
	/** 格式类型（如 email, url 等） */
	format?: fmtKey
}

/**
 * 字符串输入模式
 */
export type StringInputMode =
	| 'single' // 单行文本框
	| 'textarea' // 多行文本框
	| 'password' // 密码输入框
	| 'code' // 代码编辑器（等宽字体）

/**
 * 字符串字段配置选项
 */
export interface StringMetaOptions extends StringCheck {
	/** 输入模式（决定使用哪种输入控件） */
	mode?: StringInputMode

	/** 是否为密码字段（兼容旧写法，等价于 mode = 'password'） */
	secret?: boolean

	/** 输入框占位符文本 */
	placeholder?: string

	/** 多行输入时的初始行数（mode = 'textarea' 或 'code' 时有效） */
	rows?: number

	/** 启用自适应高度（多行输入时根据内容自动调整高度） */
	autoGrow?: boolean

	/** 显示复制按钮（用户可一键复制字段值） */
	copyable?: boolean

	/** 输入框前缀文本（显示在输入框左侧） */
	prefix?: string

	/** 输入框后缀文本（显示在输入框右侧） */
	suffix?: string

	/** 附加提示信息（在前端渲染器中使用，如显示在字段下方的小提示） */
	note?: string
}
