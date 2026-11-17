import { MantineProvider } from '@mantine/core'
import type { ReactNode } from 'react'
import { workbenchTheme } from './theme.ts'

export type WorkbenchMantineProviderProps = Readonly<{
	/** The hosting Shell's colour scheme, normally `host.colorScheme`. */
	colorScheme: 'light' | 'dark'
	children?: ReactNode
}>

/**
 * Mantine Provider for a Plugin renderer root. Uses `workbenchTheme` and the host colour scheme,
 * and leaves CSS variables and global classes to the Shell: a second set would override the
 * Shell's accent and surfaces for the whole document.
 */
export function WorkbenchMantineProvider({ colorScheme, children }: WorkbenchMantineProviderProps) {
	return (
		<MantineProvider
			theme={workbenchTheme}
			forceColorScheme={colorScheme}
			withCssVariables={false}
			withGlobalClasses={false}
		>
			{children}
		</MantineProvider>
	)
}
