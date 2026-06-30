import type { AnyElysiaApp } from '../../services/http/elysia'
import { listSecurityEvents } from '../../services/security/audit'
import { RUNTIME_SECURITY_BASE } from '../../web/paths'

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

export const securityRoutes = (app: AnyElysiaApp) =>
	app.group(RUNTIME_SECURITY_BASE, (security) =>
		security
			.get('/', async ({ set, pluginCtx, request }) => {
				setNoStore(set)
				return {
					verification: await pluginCtx.root.verification.describe({ request }),
					vault: await pluginCtx.root.vaultAdmin.describe(),
				}
			})
			.get('/events', ({ set, pluginCtx }) => {
				setNoStore(set)
				return listSecurityEvents(pluginCtx, 40)
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
