import { installRootCapability, installScopeCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host/browser'
import { Fs } from './fs/token'
import { TinyBase, TinyBaseHost } from './tinybase/token'
import { TinyBaseRuntime } from './tinybase/service'
import type { TinyBaseOptions } from './tinybase/types'

export { TinyBase, TinyBaseHost } from './tinybase/token'
export { TinyBaseError } from './tinybase/error'
export type {
	TinyBaseService,
	TinyBaseHostService,
	TinyBaseOptions,
	TinyBaseIdentity,
	TinyBaseStatus,
} from './tinybase/types'

/** Install Host-owned native Stores and private documents, borrowing the same FS as Vault and plugins. */
export function tinybase(options: TinyBaseOptions = {}) {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[services.tinybase] options must be an object')
	for (const key of Object.keys(options))
		if (key !== 'maxSnapshotBytes')
			throw new TypeError(`[services.tinybase] Unknown option: ${key}`)
	const { maxSnapshotBytes: maxBytes = 8 * 1024 * 1024 } = options
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		throw new TypeError('[services.tinybase] maxSnapshotBytes must be a positive safe integer')
	return defineHostService({
		name: 'TinyBase',
		requires: { fs: Fs },
		capabilities: [
			installRootCapability(TinyBaseHost, {
				create: (root) => new TinyBaseRuntime(root, root.require(Fs), maxBytes),
			}),
			installScopeCapability(TinyBase, {
				property: 'tinybase',
				create: (ctx) => (ctx.root.require(TinyBaseHost) as TinyBaseRuntime).forOwner(ctx),
			}),
		],
		lifecycle: (ctx) => (ctx.require(TinyBaseHost) as TinyBaseRuntime).lifecycle,
	})
}
