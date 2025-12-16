import type { HmrWebClient } from './web'

declare module '@pluxel/plugin-ui' {
	interface ExtensionServices {
		hmr: HmrWebClient
	}
}

export {}
