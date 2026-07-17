import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import {
	workbenchProjectionQuery,
	WorkbenchProjectionStore,
	workbenchProjectionDatabase,
	workbenchProjections,
} from '@repo/chatbots-adapter-kit/workbench-projection'
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
	private projections?: WorkbenchProjectionStore
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
		if (this.ctx.workbench.enabled) {
			const database = await this.ctx.database.use(workbenchProjectionDatabase)
			this.projections = new WorkbenchProjectionStore(database)
			await this.refreshProjection()
			this.ctx.workbench.mount(ChatAccessWorkbench, {
				commands: workbench.bind.rpc(() => new ChatAccessRpc(this)),
				overview: workbench.bind.liveQuery({
					database,
					dependsOn: [workbenchProjections],
					query: workbenchProjectionQuery<AccessOverviewDoc>('overview'),
				}),
				users: workbench.bind.liveQuery({
					database,
					dependsOn: [workbenchProjections],
					query: workbenchProjectionQuery<ChatUser>('users'),
				}),
				roles: workbench.bind.liveQuery({
					database,
					dependsOn: [workbenchProjections],
					query: workbenchProjectionQuery<ChatRole>('roles'),
				}),
			})
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
			void this.applyProjection(change)
			void this.refreshOverview()
		} catch (error) {
			this.ctx.logger.warn('Failed to update chat access workbench projection', { error })
		}
	}

	private async applyProjection(change: ChatAccessChange): Promise<void> {
		const operations: Array<Promise<void> | undefined> = []
		for (const id of change.userIds ?? []) {
			const user = this.domain.getUser(id)
			if (user) operations.push(this.projections?.upsert('users', user))
		}
		for (const id of change.removedUserIds ?? [])
			operations.push(this.projections?.remove('users', id))
		for (const id of change.roleIds ?? []) {
			const role = this.domain.getRole(id)
			if (role) operations.push(this.projections?.upsert('roles', role))
		}
		for (const id of change.removedRoleIds ?? [])
			operations.push(this.projections?.remove('roles', id))
		await Promise.all(operations)
	}

	private async refreshProjection(): Promise<void> {
		const users = this.domain.listUsers()
		const roles = this.domain.listRoles()
		await Promise.all([
			this.projections?.replaceAll('users', users),
			this.projections?.replaceAll('roles', roles),
			this.refreshOverview(),
		])
	}

	private async refreshOverview(): Promise<void> {
		const summary = this.domain.overview()
		await this.projections?.upsert('overview', {
			id: 'overview',
			...summary,
			updatedAt: Date.now(),
		})
	}
}
