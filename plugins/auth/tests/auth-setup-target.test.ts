import { RpcStub, RpcTarget } from 'capnweb'
import { describe, expect, it } from 'vitest'
import { AuthSetupTarget } from '../src/auth-setup-target.ts'
import { CredentialProvisioning } from '../src/credential-provisioning.ts'
import type { AuthSetupSnapshot } from '../src/workbench.ts'

function createTarget(snapshot: () => AuthSetupSnapshot) {
	return new AuthSetupTarget({
		authorized: true,
		signal: new AbortController().signal,
		snapshot,
		mutate: (operation) => operation(),
		provisioning: new CredentialProvisioning(
			{ type: 'password' },
			{ available: false, saveAccount: async () => {}, saveOidcSecret: async () => {} },
			() => {},
			() => {},
		),
	})
}

describe('Auth setup RPC boundary', () => {
	it('rejects capabilities hidden in a producer snapshot before export', async () => {
		const snapshot = {
			mode: 'password',
			state: 'configured',
			hidden: new RpcTarget(),
		} as const
		using api = new RpcStub(createTarget(() => snapshot))
		await expect(api.snapshotDto()).rejects.toThrow('contains non-portable data')
	})

	it('does not expose lifecycle and mutation implementation helpers', async () => {
		using api = new RpcStub(createTarget(() => ({ mode: 'password', state: 'configured' })))
		const unexpected = api as unknown as {
			close(): Promise<void>
			assertActive(): Promise<void>
			setupUnavailable(): Promise<void>
		}
		await expect(unexpected.close()).rejects.toThrow("'close' is not a function.")
		await expect(unexpected.assertActive()).rejects.toThrow("'assertActive' is not a function.")
		await expect(unexpected.setupUnavailable()).rejects.toThrow(
			"'setupUnavailable' is not a function.",
		)
		await expect(api.snapshotDto()).resolves.toEqual({ mode: 'password', state: 'configured' })
	})
})
