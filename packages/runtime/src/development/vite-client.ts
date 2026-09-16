import type { UserConfig } from 'vite'
const WORKBENCH_CLIENT_OPTIMIZE_DEPS = ['@tabler/icons-react', '@pluxel/runtime > capnweb'] as const
/**
 * Declares the Workbench browser graph before Vite creates its dependency optimizer.
 *
 * This must be returned from a plugin `config` hook. Mutating the resolved client environment from
 * `configureServer` races Vite's initial scan and can leave an incremental optimizer batch without
 * metadata for dependencies from the previous batch.
 */
export function createWorkbenchViteClientConfig(clientEntryUrl: string): UserConfig {
	const entry = clientEntryUrl.startsWith('/@fs/')
		? clientEntryUrl.slice('/@fs'.length)
		: clientEntryUrl
	return {
		optimizeDeps: {
			entries: [entry],
			include: [...WORKBENCH_CLIENT_OPTIMIZE_DEPS],
			noDiscovery: false,
			holdUntilCrawlEnd: true,
			ignoreOutdatedRequests: true,
		},
	}
}
