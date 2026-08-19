'use client'

import { MantineProvider } from '@mantine/core'
import { useTheme } from 'next-themes'
import { type ReactNode, useEffect, useRef } from 'react'

export function MantineThemeProvider({ children }: { children: ReactNode }) {
	const { resolvedTheme } = useTheme()
	const scopeRef = useRef<HTMLDivElement>(null)
	const colorScheme = resolvedTheme === 'dark' ? 'dark' : 'light'

	useEffect(() => {
		// Older page instances wrote this attribute to <html>; clear it after client navigation.
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
