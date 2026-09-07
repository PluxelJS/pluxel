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

/** Rewrites runtime-dev's monorepo carrier source bridge to its published package boundary. */
export function pluxelRuntimeNodeSourceBridgeExternal(): Plugin {
	return {
		name: 'pluxel:externalize-runtime-node-source-bridge',
		enforce: 'pre',
		resolveId: {
			filter: { id: /^\.\.\/\.\.\/runtime-node\/src\/index\.ts$/ },
			handler() {
				return { id: '@pluxel/runtime-node', external: true }
			},
		},
	}
}
