export const LAST_ROUTE_KEY = 'pluxel:last-route'
export const HOME_MANUAL_KEY = 'pluxel:home-manual'
export const PLUGIN_SEARCH_KEY = 'pluxel:plugin-search'
export const PLUGIN_SEARCH_EVENT = 'pluxel:set-plugin-search'

declare global {
	interface Window {
		__PLUXEL_MARKET_BASE_URL__?: string
		PLUXEL_MARKET_BASE_URL?: string
	}
}

const runtimeMarketBase =
	typeof window !== 'undefined'
		? window.__PLUXEL_MARKET_BASE_URL__ ?? window.PLUXEL_MARKET_BASE_URL
		: undefined

export const MARKET_BASE_URL =
	runtimeMarketBase ??
	(import.meta.env?.VITE_PLUXEL_MARKET_BASE_URL as string | undefined) ??
	'https://market.pluxel.dev'
