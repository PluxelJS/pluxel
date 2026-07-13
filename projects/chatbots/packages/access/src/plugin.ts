import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import type { ExtensionUiRpcMap as _ExtensionUiRpcMap } from '@pluxel/runtime/web'
import type { ChatMessage } from '@repo/chatbots-contracts'
import { ChatHubPlugin } from '@repo/chatbots-hub'
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
import { ChatAccessDomain, type ChatAccessChange } from './service.ts'
import { CoalescedSnapshotWriter } from './snapshot-writer.ts'
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
	private snapshotWriter?: CoalescedSnapshotWriter

	constructor(private readonly hub: ChatHubPlugin) {
		super()
	}

	override async init(): Promise<void> {
		this.domain = new ChatAccessDomain(await this.loadState(), (change) => this.changed(change))
		this.snapshotWriter = new CoalescedSnapshotWriter(
			() => this.domain.serialize(),
			(snapshot) =>
				this.ctx.root.persistence
					.namespace(STORAGE_NAMESPACE)
					.put(STORAGE_KEY, snapshot, { atomic: true }),
			(error) => this.ctx.logger.warn('Failed to persist chat access state', { error }),
		)
		this.ctx.effects.defer(() => this.snapshotWriter?.drain())
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

	private changed(change: ChatAccessChange): void {
		if (change.kind === 'state') this.snapshotWriter?.request()
		try {
			this.applyProjection(change)
			this.refreshOverview()
		} catch (error) {
			this.ctx.logger.warn('Failed to update chat access management projection', { error })
		}
	}

	private applyProjection(change: ChatAccessChange): void {
		for (const id of change.userIds ?? []) {
			const user = this.domain.getUser(id)
			if (user) this.usersProjection?.replaceOne({ id }, user, { upsert: true })
		}
		for (const id of change.removedUserIds ?? []) this.usersProjection?.removeOne({ id })
		for (const id of change.roleIds ?? []) {
			const role = this.domain.getRole(id)
			if (role) this.rolesProjection?.replaceOne({ id }, role, { upsert: true })
		}
		for (const id of change.removedRoleIds ?? []) this.rolesProjection?.removeOne({ id })
	}

	private refreshProjection(): void {
		const users = this.domain.listUsers()
		const roles = this.domain.listRoles()
		this.usersProjection?.removeMany({})
		for (const user of users) this.usersProjection?.insert(user)
		this.rolesProjection?.removeMany({})
		for (const role of roles) this.rolesProjection?.insert(role)
		this.refreshOverview()
	}

	private refreshOverview(): void {
		const summary = this.domain.overview()
		this.overview?.replaceOne(
			{ id: 'overview' },
			{
				id: 'overview',
				...summary,
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
