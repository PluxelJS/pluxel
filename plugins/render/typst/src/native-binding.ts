import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type {
	NodeCompiler as UpstreamCompiler,
	NodeTypstDocument,
} from '@myriaddreamin/typst-ts-node-compiler'
import type { TypstRegion } from './page-render.ts'
import type { TypstNavigation } from './preview-contract.ts'

/** Resolve from the Plugin package, before its worker source is extracted into a cache. */
export function resolveNativeBinding(moduleUrl: string): string {
	const root = dirname(createRequire(moduleUrl).resolve('@pluxel/plugin-typst/package.json'))
	return join(root, 'native/compiler.node')
}

/** Native code is loaded inside the executing worker, using its owner's explicit package path. */
export function loadNativeCompiler(path: string): typeof UpstreamCompiler {
	return (createRequire(import.meta.url)(path) as { NodeCompiler: typeof UpstreamCompiler })
		.NodeCompiler
}
export type NodeCompiler = UpstreamCompiler
export type NavigationDocument = NodeTypstDocument & {
	navigation(): TypstNavigation
	renderPage(
		page: number,
		scale: number,
		region: TypstRegion | undefined,
		maxBytes: number,
	): {
		data: Uint8Array
		width: number
		height: number
		region: TypstRegion
	}
}
