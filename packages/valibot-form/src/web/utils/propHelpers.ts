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
