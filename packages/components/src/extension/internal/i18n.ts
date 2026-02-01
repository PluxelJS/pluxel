import type { I18nLocale, I18nMessageDict, I18nResources, I18nService, PluginI18nBundle } from '../types'

const resources: I18nResources = Object.create(null)
const keysByPlugin = new Map<string, Map<I18nLocale, Set<string>>>()

let currentLocale: I18nLocale =
	typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language
		? navigator.language
		: 'en'
let fallbackLocale: I18nLocale | undefined = 'en'

const dateCache = new Map<string, Intl.DateTimeFormat>()
const numberCache = new Map<string, Intl.NumberFormat>()

function safeJsonKey(value: unknown): string {
	try {
		return JSON.stringify(value) ?? ''
	} catch {
		return ''
	}
}

function getDateFormatter(locale: string, opts?: Intl.DateTimeFormatOptions) {
	const key = `${locale}::${opts ? safeJsonKey(opts) : ''}`
	const cached = dateCache.get(key)
	if (cached) return cached
	try {
		const fmt = new Intl.DateTimeFormat(locale, opts)
		dateCache.set(key, fmt)
		return fmt
	} catch {
		return null
	}
}

function getNumberFormatter(locale: string, opts?: Intl.NumberFormatOptions) {
	const key = `${locale}::${opts ? safeJsonKey(opts) : ''}`
	const cached = numberCache.get(key)
	if (cached) return cached
	try {
		const fmt = new Intl.NumberFormat(locale, opts)
		numberCache.set(key, fmt)
		return fmt
	} catch {
		return null
	}
}

function getDict(locale: I18nLocale): I18nMessageDict {
	let dict = resources[locale]
	if (!dict) {
		dict = Object.create(null)
		resources[locale] = dict
	}
	return dict
}

function normalizeBundles(input: PluginI18nBundle | PluginI18nBundle[] | null | undefined): PluginI18nBundle[] {
	if (!input) return []
	return Array.isArray(input) ? input.filter(Boolean) : [input]
}

export function registerPluginI18n(pluginName: string, input: PluginI18nBundle | PluginI18nBundle[]): void {
	unregisterPluginI18n(pluginName)

	const bundles = normalizeBundles(input)
	if (!bundles.length) return

	let pluginLocales = keysByPlugin.get(pluginName)
	if (!pluginLocales) {
		pluginLocales = new Map()
		keysByPlugin.set(pluginName, pluginLocales)
	}

	for (const bundle of bundles) {
		const ns = typeof bundle?.namespace === 'string' && bundle.namespace ? bundle.namespace : pluginName
		const res = bundle?.resources
		if (!res || typeof res !== 'object') continue

		for (const [locale, dict] of Object.entries(res)) {
			if (!dict || typeof dict !== 'object') continue
			const target = getDict(locale)
			let set = pluginLocales.get(locale)
			if (!set) {
				set = new Set()
				pluginLocales.set(locale, set)
			}
			for (const [key, value] of Object.entries(dict)) {
				if (typeof value !== 'string') continue
				const fullKey = `${ns}.${key}`
				target[fullKey] = value
				set.add(fullKey)
			}
		}
	}
}

export function unregisterPluginI18n(pluginName: string): void {
	const pluginLocales = keysByPlugin.get(pluginName)
	if (!pluginLocales) return
	for (const [locale, keys] of pluginLocales) {
		const dict = resources[locale]
		if (!dict) continue
		for (const key of keys) {
			delete dict[key]
		}
	}
	keysByPlugin.delete(pluginName)
}

export function setExtensionLocale(locale: I18nLocale, options?: { fallbackLocale?: I18nLocale }) {
	currentLocale = locale
	if (options && 'fallbackLocale' in options) fallbackLocale = options.fallbackLocale
}

const extensionI18nService: I18nService = {
	get locale() {
		return currentLocale
	},
	get fallbackLocale() {
		return fallbackLocale
	},
	t: (key, params, options) => {
		const lookup = (loc: string) => resources?.[loc]?.[key]
		const template =
			lookup(currentLocale) ??
			(fallbackLocale ? lookup(fallbackLocale) : undefined) ??
			options?.defaultValue ??
			key
		if (!params) return template
		return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, rawName) => {
			const name = String(rawName)
			const value = (params as any)[name] as unknown
			if (value === undefined || value === null) return ''
			if (value instanceof Date) return extensionI18nService.formatDate(value)
			if (typeof value === 'number') return String(value)
			if (typeof value === 'boolean') return value ? 'true' : 'false'
			return String(value)
		})
	},
	has: (key, locale) => {
		const loc = locale ?? currentLocale
		return typeof resources?.[loc]?.[key] === 'string'
	},
	formatDate: (value, opts) => {
		const date = typeof value === 'number' ? new Date(value) : value
		const fmt = getDateFormatter(currentLocale, opts)
		if (!fmt) return date.toISOString()
		try {
			return fmt.format(date)
		} catch {
			return date.toISOString()
		}
	},
	formatNumber: (value, opts) => {
		const fmt = getNumberFormatter(currentLocale, opts)
		if (!fmt) return String(value)
		try {
			return fmt.format(value)
		} catch {
			return String(value)
		}
	},
}

export function getExtensionI18nService(): I18nService {
	return extensionI18nService
}

