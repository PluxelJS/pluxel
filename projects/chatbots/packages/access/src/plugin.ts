import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench, type MountedWorkbenchCollections } from '@pluxel/runtime/workbench'
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
import { parseAccessState } from './state.ts'
import { ChatAccessWorkbench } from './workbench-extension.ts'

const STORAGE_NAMESPACE = 'chatbots/access'
const STORAGE_KEY = 'state.json'

@Plugin({ name: 'ChatAccessPlugin' })
export class ChatAccessPlugin extends BasePlugin {
	private domain!: ChatAccessDomain
	private overview?: MountedWorkbenchCollections<typeof ChatAccessWorkbench>['overview']
	private usersProjection?: MountedWorkbenchCollections<typeof ChatAccessWorkbench>['users']
	private rolesProjection?: MountedWorkbenchCollections<typeof ChatAccessWorkbench>['roles']
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
		const mounted = this.ctx.workbench.mount(ChatAccessWorkbench, {
			commands: workbench.provide.rpc(() => new ChatAccessRpc(this)),
			overview: workbench.provide.collection(),
			users: workbench.provide.collection(),
			roles: workbench.provide.collection(),
		})
		if (mounted) {
			this.overview = mounted.collections.overview
			this.usersProjection = mounted.collections.users
			this.rolesProjection = mounted.collections.roles
			await Promise.all([
				this.overview.ready(),
				this.usersProjection.ready(),
				this.rolesProjection.ready(),
			])
			this.refreshProjection()
		}
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
		return parseAccessState(JSON.parse(raw))
	}

	private changed(change: ChatAccessChange): void {
		if (change.kind === 'state') this.snapshotWriter?.request()
		try {
			this.applyProjection(change)
			this.refreshOverview()
		} catch (error) {
			this.ctx.logger.warn('Failed to update chat access workbench projection', { error })
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
