// app/ClientOnly.tsx
import { useEffect, useState } from 'react'
export function ClientOnly({ children, fallback = null }: any) {
	const [mounted, setMounted] = useState(false)
	useEffect(() => setMounted(true), [])
	return mounted ? children : fallback
}
