import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type {
	NodeCompiler as UpstreamCompiler,
	NodeTypstDocument,
} from '@myriaddreamin/typst-ts-node-compiler'
import type { TypstRegion } from './page-render.ts'
import type { TypstNavigation } from './preview-contract.ts'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('@pluxel/typst/package.json'))

/** The pinned upstream NAPI binding, extended with navigation on its compiled document. */
export const NodeCompiler = (
	require(join(root, 'native/compiler.node')) as { NodeCompiler: typeof UpstreamCompiler }
).NodeCompiler
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
