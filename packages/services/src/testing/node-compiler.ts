import type { Context } from '@pluxel/core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeModuleHost } from '../node/token'

/** @internal The test host owns this attachment and disposes it after its runtime stops. */
export async function attachTestNodeCompiler(ctx: Context): Promise<AsyncDisposable | undefined> {
	if (!('nodeModules' in ctx)) return undefined
	if (ctx.root.require(NodeModuleHost).hasArtifactConfiguration) return undefined
	await using resources = new AsyncDisposableStack()
	const cacheDir = await mkdtemp(join(tmpdir(), 'pluxel-test-node-'))
	resources.defer(() => rm(cacheDir, { recursive: true, force: true }))
	const { attachNodeArtifactCompiler } = await import('../development/node')
	const compiler = attachNodeArtifactCompiler(ctx, { cacheDir, watch: false })
	resources.defer(() => compiler.dispose())
	return resources.move()
}
