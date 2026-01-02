import type { HmrWebClient } from './client'

declare module '@pluxel/hmr-web' {
	interface ExtensionServices {
		/**
		 * Host-provided HMR web client.
		 *
		 * Note: once `@pluxel/hmr-web` is in the TS program, UI plugins are expected
		 * to run within the HMR host, so this is required (works well with
		 * `strictNullChecks` + `exactOptionalPropertyTypes` in external projects).
		 */
		hmr: HmrWebClient
	}
}
