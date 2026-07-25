import { useEffect, useState } from 'react'

/**
 * 延迟设置 flag 为 true，立即设置为 false
 * 用于防止闪烁等场景
 */
export function useDebouncedFlag(value: boolean, delay = 200) {
	const [v, setV] = useState(value)

	useEffect(() => {
		if (value) {
			const timer = setTimeout(() => setV(true), delay)
			return () => clearTimeout(timer)
		}
		setV(false)
		return undefined
	}, [value, delay])

	return v
}
