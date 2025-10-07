import { useEffect, useState } from 'react'

export function useDebouncedFlag(value: boolean, delay = 200) {
	const [v, setV] = useState(value)

	useEffect(() => {
		if (value) {
			const timer = setTimeout(() => setV(true), delay)
			return () => clearTimeout(timer)
		}
		setV(false)
	}, [value, delay])

	return v
}
