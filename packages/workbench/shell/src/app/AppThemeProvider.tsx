import { localStorageColorSchemeManager, MantineProvider } from '@mantine/core'
import type { PropsWithChildren } from 'react'
import { appCssVariablesResolver, useAppTheme } from '../theme'

const colorSchemeManager = localStorageColorSchemeManager({
	key: 'pluxel-color-scheme',
})

export function AppThemeProvider({ children }: PropsWithChildren) {
	const { theme } = useAppTheme()
	return (
		<MantineProvider
			theme={theme}
			colorSchemeManager={colorSchemeManager}
			defaultColorScheme="auto"
			withCssVariables
			cssVariablesResolver={appCssVariablesResolver}
		>
			{children}
		</MantineProvider>
	)
}
