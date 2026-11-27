import { baseLocale, isLocale, type Locale } from '#i18n'
import { useLocalStorage } from '@mantine/hooks'
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

const AppLocaleContext = createContext<Readonly<{
	locale: Locale
	setLocale(locale: Locale): void
}> | null>(null)

export function AppLocaleProvider({ children }: { children: ReactNode }) {
	const [storedLocale, setLocale] = useLocalStorage<Locale>({
		key: 'pluxel-workbench-locale',
		defaultValue: baseLocale,
		getInitialValueInEffect: false,
	})
	const locale = isLocale(storedLocale) ? storedLocale : baseLocale
	const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])

	useEffect(() => {
		const root = document.documentElement
		const previous = root.lang
		root.lang = locale
		return () => {
			root.lang = previous
		}
	}, [locale])

	return <AppLocaleContext.Provider value={value}>{children}</AppLocaleContext.Provider>
}

export function useAppLocale() {
	const value = useContext(AppLocaleContext)
	if (!value) throw new Error('AppLocaleProvider required')
	return value
}
