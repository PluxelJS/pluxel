import type { Context } from '../context/Context'
import { admitOwnerInvocation, releaseOwnerInvocation } from '../internal/owner-invocations'

/** Admit initialization and the complete operation before either owner can close. */
export async function runVaultOperation<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
	const root = admitOwnerInvocation(ctx.root)
	try {
		const owner = ctx === ctx.root ? undefined : admitOwnerInvocation(ctx)
		try {
			return await run()
		} finally {
			if (owner) releaseOwnerInvocation(owner)
		}
	} finally {
		releaseOwnerInvocation(root)
	}
}
