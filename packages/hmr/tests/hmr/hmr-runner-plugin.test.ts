import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { HMRService } from '../../src/services/runtime/hmr/HMRService'
import { fixturesPluginsRelFromWorkspace, workspaceRoot } from './_paths'

const noop = () => undefined

// Minimal ctx stub to construct HMRService without booting Vite.
const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: { info: noop, error: noop, warn: noop },
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
		honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer: noop } },
	} as unknown
}

describe('HMRService runner plugin', () => {
	it('does not suppress Vite hot updates for the client UI', () => {
		const cwd = workspaceRoot
		const hmr = new HMRService(createCtx(), {
			roots: [join(cwd, fixturesPluginsRelFromWorkspace)],
			entries: [],
		})

		const plugin = (hmr as unknown as { plugin: { handleHotUpdate?: unknown } }).plugin
		expect(plugin.handleHotUpdate).toBeUndefined()
	})
})
