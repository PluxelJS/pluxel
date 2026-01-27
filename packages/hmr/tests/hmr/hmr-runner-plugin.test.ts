import { describe, expect, it } from 'bun:test'
import { join } from 'pathe'
import { HMRService } from '../../src/services/hmr/HMRService'

const noop = () => undefined

// Minimal ctx stub to construct HMRService without booting Vite.
const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: { info: noop, error: noop, warn: noop },
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
		const cwd = process.cwd()
		const hmr = new HMRService(createCtx(), {
			roots: [join(cwd, 'tests/fixtures/plugins')],
		})

		const plugin = (hmr as unknown as { plugin: { handleHotUpdate?: unknown } }).plugin
		expect(plugin.handleHotUpdate).toBeUndefined()
	})
})
