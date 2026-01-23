import { describe, expect, it } from 'bun:test'
import { join, normalize } from 'pathe'
import { HMRService } from '../../src/services/hmr/HMRService'

// Minimal ctx stub to construct HMRService without booting Vite.
const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: { info() {}, error() {}, warn() {} },
		loader: {
			api: {
				anchors: {
					list: () => anchors,
					remove: (id: string) => anchors.delete(id),
				},
			},
			replaceModule: async () => true,
			pruneModule() {},
		},
		registry: {
			commit: async () => ({}),
			container: { services: new Map() },
		},
		honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer() {} } },
	} as any
}

const pkgRoot = process.cwd()
const pluginDir = join(pkgRoot, 'tests/fixtures/plugins')
const pluginFile = join(pluginDir, 'PluginA.ts')

describe('HMRService file filter', () => {
	it('accepts relative, absolute and /@fs watcher paths inside scan roots', () => {
		const ctx = createCtx()
		const hmr = new HMRService(ctx, {
			dir: [pluginDir],
			log: { useColors: false },
		})
		// Simulate Vite configuring server root to packages/hmr (matches real dev script)
		hmr.setServerRoot(pkgRoot)

		const filter = hmr.toolkit.pathFilter
		const relPath = normalize('tests/fixtures/plugins/PluginA.ts')
		const cleanRel = hmr.normalizeId(relPath)

		expect(cleanRel).toBe(pluginFile)
		expect(filter(relPath)).toBe(true)
		expect(filter(pluginFile)).toBe(true)
		expect(filter(`/@fs${pluginFile}`)).toBe(true)
		expect(filter(join(pkgRoot, 'node_modules/some/pkg/index.ts'))).toBe(false)
	})
})
