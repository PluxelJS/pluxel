import type { Context } from '../context/Context'
import { enterOwnerInvocation } from '../internal/owner-invocations'

/** Admit initialization and the complete operation before either owner can close. */
export async function runVaultOperation<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
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
