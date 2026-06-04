import type { ScanService } from '@pluxel/runtime-loader/services'
import { clearSieveState, getOrCreatePromise, isBarePackageSpecifier } from '@pluxel/runtime/shared'
import type { HmrPathApi } from './environment'

export class WorkspaceEntryResolver {
	private readonly cache = new Map<string, Promise<string | null>>()

	constructor(
		private readonly scanService: Pick<ScanService, 'resolveEntry'>,
		private readonly path: HmrPathApi,
		private readonly workspaceConditions: readonly string[],
		private readonly cacheLimit = 2000,
	) {}

	resolveBareWorkspaceEntry(specifier: string): Promise<string | null> {
		if (!isBarePackageSpecifier(specifier)) return Promise.resolve(null)

		return getOrCreatePromise(
			this.cache,
			specifier,
			async () => {
				try {
					const res = await this.scanService.resolveEntry(
						{ name: specifier },
						{
							workspaceOnly: true,
							scan: {
								conditions: [...this.workspaceConditions],
								preferHmrExports: true,
							},
						},
					)
					return res.ok ? this.path.toClean(res.entry) : null
				} catch {
					return null
				}
			},
			{
				limit: this.cacheLimit,
				// Avoid caching negative results forever: workspace state can change during dev.
				evictIf: (resolved) => !resolved,
			},
		)
	}

	clear() {
		this.cache.clear()
		clearSieveState(this.cache)
	}
}
