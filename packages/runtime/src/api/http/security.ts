import type { AnyElysiaApp } from '../../services/http/elysia'
import { listSecurityEvents } from '../../services/security/audit'
import type { VaultAdminApi } from '../../services/vault/types'
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

function invalidSecurityInput(status: (code: number, body: unknown) => unknown, message?: string) {
	return status(400, {
		ok: false,
		code: 'invalid_security_input',
		...(message ? { message } : {}),
	})
}

function readVaultAdmin(root: unknown): VaultAdminApi | undefined {
	return (root as { vaultAdmin?: VaultAdminApi }).vaultAdmin
}

function vaultUnavailable(status: (code: number, body: unknown) => unknown) {
	return status(404, {
		code: 'vault_unavailable',
		message: 'The runtime did not install the optional Vault capability.',
	})
}

export const securityRoutes = (app: AnyElysiaApp) =>
	app.group(RUNTIME_SECURITY_BASE, (security) =>
		security
			.get('/', async ({ set, pluginCtx, request }) => {
				setNoStore(set)
				const vaultAdmin = readVaultAdmin(pluginCtx.root)
				return {
					adminAccess: await pluginCtx.root.adminAccess.describe({ request }),
					vault: vaultAdmin
						? { enabled: true as const, state: await vaultAdmin.describe() }
						: { enabled: false as const },
				}
			})
			.get('/events', ({ set, pluginCtx }) => {
				setNoStore(set)
				return listSecurityEvents(pluginCtx, 40)
			})
			.post('/vault/unlock', async ({ set, pluginCtx, status }) => {
				setNoStore(set)
				const vaultAdmin = readVaultAdmin(pluginCtx.root)
				return vaultAdmin ? await vaultAdmin.unlock() : vaultUnavailable(status)
			})
			.post('/vault/keys/host', async ({ set, pluginCtx, status }) => {
				setNoStore(set)
				const vaultAdmin = readVaultAdmin(pluginCtx.root)
				if (!vaultAdmin) return vaultUnavailable(status)
				return {
					publicKey: await vaultAdmin.ensureHostKey(),
				}
			})
			.post('/vault/keys/deploy/generate', async ({ set, pluginCtx, status }) => {
				setNoStore(set)
				const vaultAdmin = readVaultAdmin(pluginCtx.root)
				return vaultAdmin ? await vaultAdmin.generateDeployKey() : vaultUnavailable(status)
			})
			.post('/vault/keys/deploy', async ({ request, set, pluginCtx, status }) => {
				setNoStore(set)
				const vaultAdmin = readVaultAdmin(pluginCtx.root)
				if (!vaultAdmin) return vaultUnavailable(status)
				const body = await readJsonObject(request)
				const recipients = body ? readRecipients(body.publicKeys) : null
				if (!recipients) return invalidSecurityInput(status)
				return await vaultAdmin.setDeployRecipients(recipients)
			}),
	)
