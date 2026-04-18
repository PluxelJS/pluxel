import type { AnyElysiaApp } from '../../services/http/elysia'
import { listSecurityEvents } from '../../services/security/audit'
import type {
	VerificationMethod,
	VerificationMode,
	VerificationOtpUserProvisionInput,
	VerificationPasskeyRegistrationFinishInput,
	VerificationPasskeyRegistrationStartInput,
	VerificationPasswordUserUpsertInput,
	VerificationUserDeleteInput,
} from '../../services/verification/types'
import { HMR_SECURITY_BASE } from '../../web/paths'

function setNoStore(set: { headers: Record<string, string | number> }) {
	set.headers['cache-control'] = 'no-store'
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
	const body = await request.json().catch((): null => null)
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	return body as Record<string, unknown>
}

function readStringOrNull(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed || null
}

function readRecipients(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null
	const seen = new Set<string>()
	const recipients: string[] = []
	for (const entry of value) {
		const recipient = readStringOrNull(entry)
		if (!recipient || seen.has(recipient)) continue
		seen.add(recipient)
		recipients.push(recipient)
	}
	return recipients
}

function readVerificationMode(value: unknown): VerificationMode | null {
	if (value === 'enforce' || value === 'bypass') return value
	return null
}

function readVerificationMethod(value: unknown): VerificationMethod | null {
	if (value === 'password' || value === 'otp' || value === 'passkey') return value
	return null
}

function invalidSecurityInput(
	status: (code: number, body: unknown) => unknown,
	message?: string,
) {
	return status(400, {
		ok: false,
		code: 'invalid_security_input',
		...(message ? { message } : {}),
	})
}

function securityErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback
}

function readUsernameInput(body: Record<string, unknown>): string {
	return readStringOrNull(body.username) ?? ''
}

export const securityRoutes = (app: AnyElysiaApp) =>
	app.group(HMR_SECURITY_BASE, (security) =>
		security
			.get('/', async ({ set, pluginCtx, request }) => {
				setNoStore(set)
				return {
					verification: pluginCtx.root.verification.describe({ request }),
					vault: await pluginCtx.root.vaultAdmin.describe(),
				}
			})
			.get('/events', ({ set, pluginCtx }) => {
				setNoStore(set)
				return listSecurityEvents(pluginCtx, 40)
			})
			.post('/verification/mode', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const body = await readJsonObject(request)
				const mode = body ? readVerificationMode(body.mode) : null
				if (!mode) return invalidSecurityInput(status)
				try {
					return await pluginCtx.root.verification.setMode(mode)
				} catch (error) {
					return invalidSecurityInput(status, securityErrorMessage(error, 'Invalid verification settings'))
				}
			})
			.post('/verification/method', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const body = await readJsonObject(request)
				const method = body ? readVerificationMethod(body.method) : null
				if (!method) return invalidSecurityInput(status)
				try {
					return await pluginCtx.root.verification.setMethod(method)
				} catch (error) {
					return invalidSecurityInput(status, securityErrorMessage(error, 'Invalid verification method'))
				}
			})
			.post('/verification/users/password', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const body = await readJsonObject(request)
				const input: VerificationPasswordUserUpsertInput | null = body
					? {
							username: readUsernameInput(body),
							password: typeof body.password === 'string' ? body.password : '',
						}
					: null
				if (!input?.username || input.password.trim().length === 0) return invalidSecurityInput(status)
				try {
					return await pluginCtx.root.verification.upsertPasswordUser(input)
				} catch (error) {
					return invalidSecurityInput(status, securityErrorMessage(error, 'Invalid verification user'))
				}
			})
			.post('/verification/users/otp', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const body = await readJsonObject(request)
				const input: VerificationOtpUserProvisionInput | null = body
					? { username: readUsernameInput(body) }
					: null
				if (!input?.username) return invalidSecurityInput(status)
				try {
					return await pluginCtx.root.verification.provisionOtpUser(input)
				} catch (error) {
					return invalidSecurityInput(status, securityErrorMessage(error, 'Invalid verification user'))
				}
			})
			.post('/verification/passkey/register/options', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const body = await readJsonObject(request)
				const input: VerificationPasskeyRegistrationStartInput | null = body
					? { username: readUsernameInput(body) }
					: null
				if (!input?.username) return invalidSecurityInput(status)
				try {
					return await pluginCtx.root.verification.beginPasskeyRegistration({
						request,
						...input,
					})
				} catch (error) {
					return invalidSecurityInput(
						status,
						securityErrorMessage(error, 'Invalid passkey registration request'),
					)
				}
			})
			.post('/verification/passkey/register', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const body = await readJsonObject(request)
				const input = body as VerificationPasskeyRegistrationFinishInput | null
				if (
					readStringOrNull(input?.username) === null ||
					!input?.credential ||
					typeof input.credential !== 'object'
				) {
					return invalidSecurityInput(status)
				}
				try {
					return await pluginCtx.root.verification.finishPasskeyRegistration({
						request,
						...input,
					})
				} catch (error) {
					return invalidSecurityInput(status, securityErrorMessage(error, 'Invalid verification user'))
				}
			})
			.post('/verification/users/delete', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const body = await readJsonObject(request)
				const input: VerificationUserDeleteInput | null = body
					? { username: readUsernameInput(body) }
					: null
				if (!input?.username) return invalidSecurityInput(status)
				try {
					return await pluginCtx.root.verification.deleteUser(input)
				} catch (error) {
					return invalidSecurityInput(status, securityErrorMessage(error, 'Invalid verification user'))
				}
			})
			.post('/vault/unlock', async ({ set, pluginCtx }) => {
				setNoStore(set)
				return await pluginCtx.root.vaultAdmin.unlock()
			})
			.post('/vault/keys/host', async ({ set, pluginCtx }) => {
				setNoStore(set)
				return {
					publicKey: await pluginCtx.root.vaultAdmin.ensureHostKey(),
				}
			})
			.post('/vault/keys/deploy/generate', async ({ set, pluginCtx }) => {
				setNoStore(set)
				return await pluginCtx.root.vaultAdmin.generateDeployKey()
			})
			.post('/vault/keys/deploy', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const body = await readJsonObject(request)
				const recipients = body ? readRecipients(body.publicKeys) : null
				if (!recipients) return invalidSecurityInput(status)
				return await pluginCtx.root.vaultAdmin.setDeployRecipients(recipients)
			}),
		)
