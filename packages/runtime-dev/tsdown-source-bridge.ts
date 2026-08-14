import type { Plugin } from 'rolldown'

/** Keeps the monorepo-only source bridge out of published runtime route bundles. */
export function pluxelViteSourceBridgeExternal(): Plugin {
	return {
		name: 'pluxel:externalize-vite-source-bridge',
		enforce: 'pre',
		resolveId: {
			filter: { id: /^\.\.\/\.\.\/rolldown\/src\/vite\/index\.ts$/ },
			handler() {
				return { id: '@pluxel/rolldown/vite', external: true }
			},
		},
	}
}
