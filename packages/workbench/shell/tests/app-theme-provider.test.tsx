import { Center } from '@mantine/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AppThemeProvider } from '../src/app/AppThemeProvider'

vi.mock('../src/theme', () => ({
	appCssVariablesResolver: undefined,
	useAppTheme: () => ({ theme: {} }),
}))

describe('AppThemeProvider', () => {
	it('provides Mantine context to the session gate before the app is ready', () => {
		const markup = renderToStaticMarkup(
			<AppThemeProvider>
				<Center>正在连接 Workbench</Center>
			</AppThemeProvider>,
		)

		expect(markup).toContain('正在连接 Workbench')
	})
})
