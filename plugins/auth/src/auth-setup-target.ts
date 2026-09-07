import { RpcTarget } from '@pluxel/runtime/capnweb'
import { CredentialProvisioning, type CredentialSetupResult } from './credential-provisioning.ts'
import type {
	AuthOidcSecretSetupInput,
	AuthPasswordSetupInput,
	AuthSetupApi,
	AuthSetupFailure,
	AuthSetupMutationResult,
	AuthSetupSnapshot,
	AuthTotpConfirmationInput,
	AuthTotpEnrollmentResult,
} from './workbench.ts'

type AuthSetupMutation = <Result>(operation: () => Promise<Result>) => Promise<Result>

export type AuthSetupTargetOptions = Readonly<{
	authorized: boolean
	signal: AbortSignal
	provisioning: CredentialProvisioning
	snapshot(): AuthSetupSnapshot
	mutate: AuthSetupMutation
}>

function failure(code: AuthSetupFailure['code'], message: string): AuthSetupFailure {
	return Object.freeze({ ok: false, code, message })
}

export class AuthSetupTarget extends RpcTarget implements AuthSetupApi {
	private active = true

	constructor(private readonly options: AuthSetupTargetOptions) {
		super()
		options.signal.addEventListener('abort', this.close, { once: true })
		if (options.signal.aborted) this.close()
	}

	snapshot(): AuthSetupSnapshot {
		this.assertActive()
		return this.options.snapshot()
	}

	setupPassword(input: AuthPasswordSetupInput): Promise<AuthSetupMutationResult> {
		return this.runMutation(() => this.options.provisioning.setupPassword(input))
	}

	async beginTotp(input: AuthPasswordSetupInput): Promise<AuthTotpEnrollmentResult> {
		this.assertActive()
		return await this.options.mutate(async () => {
			const unavailable = this.setupUnavailable()
			if (unavailable) return unavailable
			return await this.options.provisioning.beginTotp(input)
		})
	}

	confirmTotp(input: AuthTotpConfirmationInput): Promise<AuthSetupMutationResult> {
		return this.runMutation(() => this.options.provisioning.confirmTotp(input))
	}

	setupOidcSecret(input: AuthOidcSecretSetupInput): Promise<AuthSetupMutationResult> {
		return this.runMutation(() => this.options.provisioning.setupOidcSecret(input))
	}

	[Symbol.dispose](): void {
		this.close()
	}

	private async runMutation(
		operation: () => Promise<CredentialSetupResult>,
	): Promise<AuthSetupMutationResult> {
		this.assertActive()
		return await this.options.mutate(async (): Promise<AuthSetupMutationResult> => {
			const unavailable = this.setupUnavailable()
			if (unavailable) return unavailable
			const result = await operation()
			if (result.ok === false) return result
			return Object.freeze({ ok: true as const, snapshot: this.options.snapshot() })
		})
	}

	private setupUnavailable(): AuthSetupFailure | undefined {
		this.assertActive()
		if (!this.options.authorized) {
			return failure('forbidden', 'Credential setup requires local recovery access.')
		}
		const snapshot = this.options.snapshot()
		if (snapshot.state === 'configured') {
			return failure('not_required', 'Authentication credentials are already configured.')
		}
		if (snapshot.state === 'unavailable') {
			return failure('unavailable', 'Vault is unavailable.')
		}
		return undefined
	}

	private readonly close = (): void => {
		if (!this.active) return
		this.active = false
		this.options.signal.removeEventListener('abort', this.close)
		this.options.provisioning[Symbol.dispose]()
	}

	private assertActive(): void {
		if (!this.active || this.options.signal.aborted) {
			throw new Error('Auth setup View is closed')
		}
	}
}
