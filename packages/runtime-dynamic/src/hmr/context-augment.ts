import type { LoaderHmrConfig } from './engine/LoaderHmrService'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** Loader HMR controller config (set by HMR hosts for observability). */
			loaderHmr?: LoaderHmrConfig
		}
	}
}
