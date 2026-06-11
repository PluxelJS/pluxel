import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { fixturesPluginsRelFromWorkspace, workspaceRoot } from './_paths'

const noop = () => {}

function createNoopLogger() {
	const self: any = {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		with: () => self,
	}
	return {
		...self,
		getDebugChannel: () => self,
	}
}

// Minimal ctx stub to construct LoaderHmrService without booting Vite.
const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: createNoopLogger(),
		on: () => noop,
		scanService: { resolveEntry: async () => ({ ok: false }) },
		loader: {
			api: {
				anchors: {
					list: () => anchors,
					remove: (id: string) => anchors.delete(id),
				},
			},
		},
		registry: {
			commit: async () => ({ ok: true }),
			container: { services: new Map() },
		},
		http: { vitePlugin: { name: 'noop', apply: 'serve', configureServer: noop } },
	} as unknown
}

describe('LoaderHmrService runner plugin', () => {
	it('does not suppress Vite hot updates for the client UI', () => {
		const cwd = workspaceRoot
		const hmr = new LoaderHmrService(createCtx(), {
			roots: [join(cwd, fixturesPluginsRelFromWorkspace)],
			entries: [],
		})

		const plugin = (hmr as unknown as { plugin: { handleHotUpdate?: unknown } }).plugin
		expect(plugin.handleHotUpdate).toBeUndefined()
	})
})
