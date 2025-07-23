import {
	createServerValidate,
	ServerValidateError,
} from '@tanstack/react-form/start'
import { formOpts } from './shared/formOptions' // 引入上面定义的表单配置
import * as v from 'valibot'

// 创建服务端验证函数，结合 Valibot schema
const serverValidate = createServerValidate({
	...formOpts,
	onServerValidate: (formDataOrValue) => {
		// 这里 TanStack Form 会将 formData 转换后的值传入 value
		const { value } = formDataOrValue
		// 使用 Valibot 验证表单数据
		const result = v.safeParse(schema, value) // 假设 valibot 提供 safeParse
		if (!result.success) {
			// 返回错误信息。可以返回字符串数组或错误映射，让 TanStack Form 处理
			return result.error.format()
		}
		// 如果需要其它自定义验证，也可以在这里添加
		if (value.age < 12) {
			return '服务器验证: 年龄必须至少 12 岁' // 返回全局表单错误示例:contentReference[oaicite:7]{index=7}:contentReference[oaicite:8]{index=8}
		}
		// 验证通过则不返回（或返回 undefined）
	},
})
