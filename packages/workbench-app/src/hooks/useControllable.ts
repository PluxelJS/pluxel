import { useCallback, useState } from 'react'

export interface UseControllableOptions<T> {
	value?: T
	defaultValue: T
	onChange?: (value: T) => void
}

/**
 * 受控/非受控辅助 Hook（和 Mantine 行为一致）
 * 支持组件同时作为受控和非受控组件使用
 */
export function useControllable<T>(opts: UseControllableOptions<T>) {
	const { value, defaultValue, onChange } = opts
	const [inner, setInner] = useState<T>(defaultValue)
	const isControlled = value !== undefined
	const state = isControlled ? (value as T) : inner
	const set = useCallback(
		(v: T | ((prev: T) => T)) => {
			const next = typeof v === 'function' ? (v as (prev: T) => T)(state) : v
			if (!isControlled) setInner(next)
			onChange?.(next)
		},
		[isControlled, onChange, state],
	)
	return [state, set] as const
}
