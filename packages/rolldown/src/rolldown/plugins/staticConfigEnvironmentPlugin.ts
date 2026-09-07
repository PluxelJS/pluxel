import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'rolldown'
import { createConfigSchemaSourceResolver } from './configSourcePlugin.ts'
import {
	parseStaticRuntimeDeclaration,
	type StaticRuntimeDeclarationFacts,
} from './staticConfigEnvironment.ts'
import { parseStandaloneWithLang } from './pluginUtils.ts'

export type StaticConfigEnvironmentDeclarationPluginOptions = {
	entry: string
	onDeclaration?(facts: StaticRuntimeDeclarationFacts): void
}

/** Production adapter for the shared static application declaration parser. */
export function staticConfigEnvironmentDeclarationPlugin(
	options: StaticConfigEnvironmentDeclarationPluginOptions,
): Plugin {
	const entry = resolve(options.entry)
	return {
		name: 'pluxel-static-application-declaration',
		async buildStart() {
			const code = await readFile(entry, 'utf8').catch((cause: unknown) => {
				this.error(
					`[static-application] failed to read entry ${entry}: ${cause instanceof Error ? cause.message : String(cause)}`,
				)
			})
			const ast = parseStandaloneWithLang(code, entry)
			if (!ast) this.error(`[static-application] failed to parse entry: ${entry}`)
			const facts = await parseStaticRuntimeDeclaration({
				ast,
				code,
				id: entry,
				sourceResolver: createConfigSchemaSourceResolver(this),
				error: (message) => this.error(message),
			})
			options.onDeclaration?.(facts)
		},
	}
}
