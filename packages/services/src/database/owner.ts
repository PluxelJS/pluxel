import { formatPluginNodeReference, type Context } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/internal'
import {
	readDatabaseDefinition,
	type DatabaseArtifact,
	type DatabaseDialect,
	type DatabaseSchema,
} from './artifact'

/** One definition and one in-flight acquisition per plugin generation. */
export function bindDatabaseOwner(owner: Context, dialect: DatabaseDialect) {
	let current: { definition: DatabaseSchema; handle: Promise<unknown> } | undefined
	return function use<Handle>(
		definition: DatabaseSchema,
		open: (ownerId: string, artifact: DatabaseArtifact) => Promise<Handle>,
	): Promise<Handle> {
		return runDatabaseOperation(owner, () => {
			if (current) {
				if (current.definition !== definition)
					throw new Error('[database] each plugin may use only one database definition')
				// Each installer infers its handle from this same definition.
				return current.handle as Promise<Handle>
			}
			const address = owner.pluginInfo?.nodeAddress
			if (!address) throw new Error('[database] database use requires a plugin Context')
			const artifact = readDatabaseDefinition(definition, dialect)
			const handle = open(formatPluginNodeReference(address), artifact).catch((error: unknown) => {
				current = undefined
				throw error
			})
			current = { definition, handle }
			return handle
		})
	}
}

export async function runDatabaseOperation<T>(
	ctx: Context,
	run: () => T | PromiseLike<T>,
): Promise<T> {
	const rootLease = enterOwnerInvocation(ctx.root)
	try {
		const ownerLease = ctx === ctx.root ? undefined : enterOwnerInvocation(ctx)
		try {
			return await run()
		} finally {
			ownerLease?.dispose()
		}
	} finally {
		rootLease.dispose()
	}
}
