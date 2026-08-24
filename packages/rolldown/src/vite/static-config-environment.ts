import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { createConfigSchemaSourceResolver } from '../rolldown/plugins/configSourcePlugin.ts'
import { parseStaticRuntimeDeclaration } from '../rolldown/plugins/staticConfigEnvironment.ts'
import { parseWithLang } from '../rolldown/plugins/pluginUtils.ts'

export type StaticConfigEnvironmentVitePluginOptions = {
	entry: string
}

/** Vite adapter for the same direct static declaration parser used by the freezer. */
export function staticConfigEnvironmentVitePlugin(
	options: StaticConfigEnvironmentVitePluginOptions,
): Plugin {
	let entry = resolve(options.entry)
	return {
		name: 'pluxel:static-application-declaration',
		enforce: 'pre',
		configResolved(config) {
			entry = resolve(config.root, options.entry)
		},
		async transform(code, rawId) {
			const id = rawId.replace(/[?#].*$/, '')
			if (resolve(id) !== entry) return null
			const ast = parseWithLang(this, code, id)
			if (!ast) this.error(`[static-application] failed to parse entry: ${id}`)
			await parseStaticRuntimeDeclaration({
				ast,
				code,
				id,
				sourceResolver: createConfigSchemaSourceResolver(this as never),
				error: (message) => this.error(message),
			})
			return null
		},
	}
}
