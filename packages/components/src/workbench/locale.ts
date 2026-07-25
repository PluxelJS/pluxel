import type { WorkbenchLocaleService } from '@pluxel/runtime/workbench/ui'

type Locale = string

type Listener = () => void

let currentLocale: Locale =
	typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language
		? navigator.language
		: 'en'
let fallbackLocale: Locale | undefined = 'en'

const listeners = new Set<Listener>()
const dateCache = new Map<string, Intl.DateTimeFormat>()
const numberCache = new Map<string, Intl.NumberFormat>()

function safeJsonKey(value: unknown): string {
	try {
		return JSON.stringify(value) ?? ''
	} catch {
		return ''
	}
}

function emit() {
	for (const listener of listeners) {
		listener()
	}
}

function getDateFormatter(locale: string, options?: Intl.DateTimeFormatOptions) {
	const key = `${locale}::${options ? safeJsonKey(options) : ''}`
	const cached = dateCache.get(key)
	if (cached) return cached
	const formatter = new Intl.DateTimeFormat(locale, options)
	dateCache.set(key, formatter)
	return formatter
}

function getNumberFormatter(locale: string, options?: Intl.NumberFormatOptions) {
	const key = `${locale}::${options ? safeJsonKey(options) : ''}`
	const cached = numberCache.get(key)
	if (cached) return cached
	const formatter = new Intl.NumberFormat(locale, options)
	numberCache.set(key, formatter)
	return formatter
}

export const workbenchLocale: WorkbenchLocaleService = {
	get locale() {
		return currentLocale
	},
	get fallbackLocale() {
		return fallbackLocale
	},
	setLocale(locale, options) {
		const nextLocale = String(locale || 'en')
		const nextFallback =
			options && 'fallbackLocale' in options ? options.fallbackLocale : fallbackLocale
		if (nextLocale === currentLocale && nextFallback === fallbackLocale) return
		currentLocale = nextLocale
		fallbackLocale = nextFallback
		emit()
	},
	subscribe(listener) {
		listeners.add(listener)
		return () => listeners.delete(listener)
	},
	formatDate(value, options) {
		const date = typeof value === 'number' ? new Date(value) : value
		try {
			return getDateFormatter(currentLocale, options).format(date)
		} catch {
			return date.toISOString()
		}
	},
	formatNumber(value, options) {
		try {
			return getNumberFormatter(currentLocale, options).format(value)
		} catch {
			return String(value)
		}
	},
}
