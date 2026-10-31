import { dirname, join, resolve } from 'node:path'
import { readSharedRuntimePackage, sharedRuntimes } from '@pluxel/host/internal/shared-runtime'
import {
	parseStandaloneWithLang,
	readLiteralString,
	walkAst,
} from '../rolldown/plugins/pluginUtils'
import { validateSharedRuntimePeer } from './runtime-peer'

const runtime = sharedRuntimes.tinybase

/** Native imports stay external; the service import and explicit peer establish interoperability. */
export function collectTinybaseConsumers(packageJsonPath: string) {
	let consumes = false
	return {
		usesTinybase: () => consumes,
		plugin: {
			name: 'pluxel:tinybase-boundary',
			buildStart() {
				consumes =
					readSharedRuntimePackage(join(dirname(packageJsonPath), '__entry__.mjs'), runtime)
						?.peer !== undefined
			},
			transform(code: string, id: string): null {
				if (consumes || !code.includes(runtime.entry)) return null
				const owner = readSharedRuntimePackage(id, runtime)
				if (owner?.manifestPath !== resolve(packageJsonPath)) return null
				const ast = parseStandaloneWithLang(code, id)
				if (!ast) return null
				walkAst(ast, (node) => {
					if (readLiteralString(node.source) !== runtime.entry) return
					if (node.type === 'ImportExpression') consumes = true
					if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
						const specifiers = node.specifiers as { importKind?: string }[]
						if (
							specifiers.length === 0 ||
							specifiers.some((specifier) => specifier.importKind !== 'type')
						)
							consumes = true
					}
					if (
						(node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
						node.exportKind !== 'type'
					)
						consumes = true
				})
				return null
			},
		},
	}
}

/** Source consumers validate their original installation before emitting the capability marker. */
export async function validateTinybasePeer(packageJsonPath: string): Promise<string> {
	return validateSharedRuntimePeer(packageJsonPath, runtime)
}
