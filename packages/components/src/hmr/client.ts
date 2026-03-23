import { createHmrWebClient } from '@pluxel/runtime/web/ui'

let hmr: ReturnType<typeof createHmrWebClient> | null = null

export function getHmrWebClient() {
	if (!hmr) {
		hmr = createHmrWebClient({
			fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
		})
	}

	return hmr
}
