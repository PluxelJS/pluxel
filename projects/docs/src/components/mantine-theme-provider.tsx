'use client'

import { MantineProvider } from '@mantine/core'
import { useTheme } from 'next-themes'
import { type ReactNode, useEffect, useRef } from 'react'

export function MantineThemeProvider({ children }: { children: ReactNode }) {
	const { resolvedTheme } = useTheme()
	const scopeRef = useRef<HTMLDivElement>(null)
	const colorScheme = resolvedTheme === 'dark' ? 'dark' : 'light'

	useEffect(() => {
		// 旧页面实例曾把此属性写入 <html>；客户端导航后将它清除。
		document.documentElement.removeAttribute('data-mantine-color-scheme')
	}, [])

	return (
		<div ref={scopeRef} className="pluxel-mantine-scope">
			<MantineProvider
				cssVariablesSelector=".pluxel-mantine-scope"
				forceColorScheme={colorScheme}
				getRootElement={() => scopeRef.current ?? undefined}
			>
				{children}
			</MantineProvider>
		</div>
	)
}
