import '@pluxel/runtime/register/static'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import type { ExtensionUiRpcMap as _ExtensionUiRpcMap } from '@pluxel/runtime/web'
import { ChatHubPlugin, type ChatMessage } from '@repo/chatbots-hub'
import {
	createEmptyAccessState,
	type AccessOverviewDoc,
	type AccessState,
	type ChatRole,
	type ChatUser,
	type PermissionDeclaration,
	type PermissionGrant,
} from './model.ts'
import { ChatAccessRpc } from './rpc.ts'
import { ChatAccessDomain } from './service.ts'
import { normalizeAccessState } from './state.ts'

const pluginUi = ui(import.meta.url, './ui/index.tsx')
const STORAGE_NAMESPACE = 'chatbots/access'
const STORAGE_KEY = 'state.json'

@Plugin({ name: 'ChatAccessPlugin' })
export class ChatAccessPlugin extends BasePlugin {
	private domain!: ChatAccessDomain
	private overview?: ManagementStateCollection<AccessOverviewDoc>
	private usersProjection?: ManagementStateCollection<ChatUser>
	private rolesProjection?: ManagementStateCollection<ChatRole>
	private saveTail = Promise.resolve()

	constructor(private readonly hub: ChatHubPlugin) {
		super()
	}

	override async init(): Promise<void> {
		this.domain = new ChatAccessDomain(await this.loadState(), (kind) => this.changed(kind))
		this.ctx.effects.defer(
			this.hub.registerObserver('chatbots.access.identity', (message) => {
				this.domain.resolveMessage(message)
			}),
		)
		await this.ctx.webManagement.use(async (web) => {
			this.overview = web.state.collection<AccessOverviewDoc>({ name: 'overview' })
			this.usersProjection = web.state.collection<ChatUser>({ name: 'users' })
			this.rolesProjection = web.state.collection<ChatRole>({ name: 'roles' })
			await Promise.all([
				this.overview.ready(),
				this.usersProjection.ready(),
				this.rolesProjection.ready(),
			])
			this.refreshProjection()
			web.ui.register(pluginUi)
			web.rpc.expose(() => new ChatAccessRpc(this))
		})
		this.ctx.effects.defer(() => this.saveTail)
	}

	resolveMessage(message: ChatMessage) {
		return this.domain.resolveMessage(message)
	}
	listUsers() {
		return this.domain.listUsers()
	}
	createLinkCode(userId: string, ttlMs?: number) {
		return this.domain.createLinkCode(userId, ttlMs)
	}
	consumeLinkCode(currentUserId: string, code: string) {
		return this.domain.consumeLinkCode(currentUserId, code)
	}
	declare(input: PermissionDeclaration) {
		return this.domain.declare(input)
	}
	listPermissions() {
		return this.domain.listPermissions()
	}
	authorize(userId: string, node: string) {
		return this.domain.authorize(userId, node)
	}
	setUserGrant(userId: string, grant: PermissionGrant) {
		this.domain.setUserGrant(userId, grant)
	}
	revokeUserGrant(userId: string, node: string) {
		this.domain.revokeUserGrant(userId, node)
	}
	upsertRole(role: ChatRole) {
		return this.domain.upsertRole(role)
	}
	assignRole(userId: string, roleId: string) {
		this.domain.assignRole(userId, roleId)
	}
	revokeRole(userId: string, roleId: string) {
		this.domain.revokeRole(userId, roleId)
	}
	deleteRole(roleId: string) {
		this.domain.deleteRole(roleId)
	}
	accessForUser(userId: string) {
		return this.domain.accessForUser(userId)
	}

	private async loadState(): Promise<AccessState> {
		const raw = await this.ctx.root.persistence.namespace(STORAGE_NAMESPACE).getText(STORAGE_KEY)
		if (!raw) return createEmptyAccessState()
		try {
			return normalizeAccessState(JSON.parse(raw))
		} catch (error) {
			this.ctx.logger.warn('Ignoring invalid chat access state', { error })
			return createEmptyAccessState()
		}
	}

	private changed(kind: 'state' | 'declarations'): void {
		this.refreshProjection()
		if (kind === 'declarations') return
		const snapshot = this.domain.serialize()
		this.saveTail = this.saveTail
			.then(() =>
				this.ctx.root.persistence
					.namespace(STORAGE_NAMESPACE)
					.put(STORAGE_KEY, snapshot, { atomic: true }),
			)
			.catch((error) => this.ctx.logger.warn('Failed to persist chat access state', { error }))
	}

	private refreshProjection(): void {
		const users = this.domain.listUsers()
		const roles = this.domain.listRoles()
		this.usersProjection?.removeMany({})
		for (const user of users) this.usersProjection?.insert(user)
		this.rolesProjection?.removeMany({})
		for (const role of roles) this.rolesProjection?.insert(role)
		this.overview?.replaceOne(
			{ id: 'overview' },
			{
				id: 'overview',
				users: users.length,
				identities: users.reduce((sum, user) => sum + user.identities.length, 0),
				roles: roles.length,
				permissions: this.domain.listPermissions().length,
				updatedAt: Date.now(),
			},
			{ upsert: true },
		)
	}
}

declare module '@pluxel/runtime/web' {
	interface ExtensionUiRpcMap {
		ChatAccessPlugin: ChatAccessRpc
	}
	interface ExtensionUiSignalDbMap {
		ChatAccessPlugin: { overview: AccessOverviewDoc; users: ChatUser; roles: ChatRole }
	}
}
