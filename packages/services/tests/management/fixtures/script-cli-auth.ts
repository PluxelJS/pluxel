import { BasePlugin, Plugin } from '@pluxel/core'
import '@pluxel/services/management/access'
import type {
	ManagementAccessRegistration,
	ManagementAuthenticationProviderStep,
} from '@pluxel/services/management/access'

export const SCRIPT_TEST_PASSWORD = 'local-test-script-password'
export const SCRIPT_TEST_OTHER_PASSWORD = 'other-test-script-password'
export let scriptTestAuthorization = new AbortController()
export function revokeScriptTestAuthorization(): void {
	scriptTestAuthorization.abort(new Error('Test credential revoked'))
	scriptTestAuthorization = new AbortController()
}
export const scriptTestProvider = {
	registration: undefined as ManagementAccessRegistration | undefined,
}
export const scriptTestAuthentication = { opened: 0, submitted: 0, disposed: 0 }

/** Real provider challenge for TLS/non-loopback integration; never relies on recovery admission. */
@Plugin()
export class ScriptCliAuthentication extends BasePlugin {
	protected override init(): void {
		const access = this.ctx.managementAccess
		if (!access) throw new Error('Management access service is required')
		scriptTestProvider.registration = access.provide({
			status: () => ({
				id: 'script-cli-test',
				label: 'Script test',
				method: 'password',
				ready: true,
			}),
			open: () => {
				scriptTestAuthentication.opened++
				let step: ManagementAuthenticationProviderStep = {
					kind: 'challenge',
					challenge: { kind: 'password' },
				}
				return {
					authorizationSignal: scriptTestAuthorization.signal,
					state: () => step,
					submit(input) {
						scriptTestAuthentication.submitted++
						step =
							input &&
							typeof input === 'object' &&
							'password' in input &&
							(input.password === SCRIPT_TEST_PASSWORD ||
								input.password === SCRIPT_TEST_OTHER_PASSWORD)
								? {
										kind: 'authenticated',
										principal: {
											subject:
												input.password === SCRIPT_TEST_PASSWORD ? 'script-admin' : 'other-admin',
										},
									}
								: { kind: 'failed', code: 'authentication_failed' }
						return step
					},
					[Symbol.dispose]() {
						scriptTestAuthentication.disposed++
					},
				}
			},
		})
	}
}
