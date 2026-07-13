import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	NumberInput,
	Select,
	Stack,
	Text,
	TextInput,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web/ui'
import { useEffect, useState } from 'react'
import type { PermissionEffect } from '../model.ts'
import type { AccessUiApp, UserAccess } from './types.ts'

export function AccessEditor({ app }: { app: AccessUiApp }) {
	const users = app.db.useList('users')
	const roles = app.db.useList('roles')
	const [userId, setUserId] = useState<string | null>(null)
	const [access, setAccess] = useState<UserAccess>({ roles: [], grants: [] })
	const [permissionNodes, setPermissionNodes] = useState<string[]>([])
	const [grantNode, setGrantNode] = useState('')
	const [grantEffect, setGrantEffect] = useState<PermissionEffect>('allow')
	const [roleId, setRoleId] = useState('')
	const [roleName, setRoleName] = useState('')
	const [roleRank, setRoleRank] = useState(0)
	const [roleGrantNode, setRoleGrantNode] = useState('')
	const [roleGrantEffect, setRoleGrantEffect] = useState<PermissionEffect>('allow')
	const [assignRoleId, setAssignRoleId] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		void Promise.resolve(app.rpc.listPermissions()).then((items) =>
			setPermissionNodes(items.map((item) => item.node)),
		)
	}, [app])
	useEffect(() => {
		if (!userId) {
			setAccess({ roles: [], grants: [] })
			return
		}
		void Promise.resolve(app.rpc.getUserAccess(userId))
			.then(setAccess)
			.catch((caught) => setError(rpcErrorMessage(caught, '读取用户权限失败')))
	}, [app, userId])

	const run = async (task: () => Promise<void>) => {
		setBusy(true)
		try {
			await task()
			setError(null)
		} catch (caught) {
			setError(rpcErrorMessage(caught, '权限操作失败'))
		} finally {
			setBusy(false)
		}
	}

	return (
		<Stack gap="md">
			{error ? <Alert color="red">{error}</Alert> : null}
			<Card withBorder>
				<Stack>
					<Text fw={600}>用户授权</Text>
					<Select
						label="用户"
						searchable
						placeholder="选择用户"
						data={users.map((user) => ({
							value: user.id,
							label: `${user.displayName ?? user.id} (${user.id})`,
						}))}
						value={userId}
						onChange={setUserId}
					/>
					<Group align="end">
						<TextInput
							label="权限节点"
							placeholder={permissionNodes[0] ?? 'cmd.example 或 cmd.*'}
							value={grantNode}
							onChange={(event) => setGrantNode(event.currentTarget.value)}
							style={{ flex: 1 }}
						/>
						<Select
							label="效果"
							data={[
								{ value: 'allow', label: '允许' },
								{ value: 'deny', label: '拒绝' },
							]}
							value={grantEffect}
							onChange={(value) => setGrantEffect((value as PermissionEffect) ?? 'allow')}
							w={120}
						/>
						<Button
							disabled={!userId || !grantNode.trim()}
							loading={busy}
							onClick={() =>
								void run(async () => {
									setAccess(
										await app.rpc.setUserGrant(userId!, {
											node: grantNode,
											effect: grantEffect,
										}),
									)
								})
							}
						>
							保存 grant
						</Button>
					</Group>
					<Group>
						{access.grants.map((grant) => (
							<Badge
								key={grant.node}
								color={grant.effect === 'allow' ? 'green' : 'red'}
								variant="light"
								style={{ cursor: 'pointer' }}
								onClick={() =>
									void run(async () =>
										setAccess(await app.rpc.revokeUserGrant(userId!, grant.node)),
									)
								}
							>
								{grant.effect}: {grant.node} ×
							</Badge>
						))}
					</Group>
					<Group align="end">
						<Select
							label="分配角色"
							data={roles.map((role) => ({ value: role.id, label: `${role.name} (${role.id})` }))}
							value={assignRoleId}
							onChange={setAssignRoleId}
							style={{ flex: 1 }}
						/>
						<Button
							disabled={!userId || !assignRoleId}
							onClick={() =>
								void run(async () => setAccess(await app.rpc.assignRole(userId!, assignRoleId!)))
							}
						>
							分配
						</Button>
					</Group>
					<Group>
						{access.roles.map((assigned) => (
							<Badge
								key={assigned}
								style={{ cursor: 'pointer' }}
								onClick={() =>
									void run(async () => setAccess(await app.rpc.revokeRole(userId!, assigned)))
								}
							>
								{assigned} ×
							</Badge>
						))}
					</Group>
				</Stack>
			</Card>

			<Card withBorder>
				<Stack>
					<Text fw={600}>角色</Text>
					<Group align="end">
						<TextInput
							label="ID"
							value={roleId}
							onChange={(event) => setRoleId(event.currentTarget.value)}
						/>
						<TextInput
							label="名称"
							value={roleName}
							onChange={(event) => setRoleName(event.currentTarget.value)}
						/>
						<NumberInput
							label="Rank"
							value={roleRank}
							onChange={(value) => setRoleRank(Number(value) || 0)}
							w={110}
						/>
						<Button
							disabled={!roleId.trim() || !roleName.trim()}
							onClick={() =>
								void run(async () => {
									await app.rpc.upsertRole({
										id: roleId,
										name: roleName,
										rank: roleRank,
										grants: roles.find((role) => role.id === roleId)?.grants ?? [],
									})
								})
							}
						>
							保存角色
						</Button>
					</Group>
					<Group align="end">
						<TextInput
							label="角色 grant"
							placeholder="cmd.admin.*"
							value={roleGrantNode}
							onChange={(event) => setRoleGrantNode(event.currentTarget.value)}
							style={{ flex: 1 }}
						/>
						<Select
							label="效果"
							data={[
								{ value: 'allow', label: '允许' },
								{ value: 'deny', label: '拒绝' },
							]}
							value={roleGrantEffect}
							onChange={(value) => setRoleGrantEffect((value as PermissionEffect) ?? 'allow')}
							w={120}
						/>
						<Button
							disabled={!roleId || !roleName || !roleGrantNode.trim()}
							onClick={() =>
								void run(async () => {
									const current = roles.find((role) => role.id === roleId)
									const grants = [...(current?.grants ?? [])]
									const next = { node: roleGrantNode, effect: roleGrantEffect }
									const index = grants.findIndex((grant) => grant.node === next.node)
									if (index < 0) grants.push(next)
									else grants[index] = next
									await app.rpc.upsertRole({ id: roleId, name: roleName, rank: roleRank, grants })
								})
							}
						>
							保存 role grant
						</Button>
					</Group>
					{roles.map((role) => (
						<Stack key={role.id} gap="xs">
							<Group justify="space-between">
								<Text size="sm">
									{role.name} · {role.id} · rank {role.rank}
								</Text>
								<Button
									size="xs"
									variant="subtle"
									color="red"
									onClick={() =>
										void run(async () => {
											await app.rpc.deleteRole(role.id)
										})
									}
								>
									删除
								</Button>
							</Group>
							<Group>
								{role.grants.map((grant) => (
									<Badge
										key={grant.node}
										color={grant.effect === 'allow' ? 'green' : 'red'}
										variant="light"
										style={{ cursor: 'pointer' }}
										onClick={() =>
											void run(async () => {
												await app.rpc.upsertRole({
													...role,
													grants: role.grants.filter((item) => item.node !== grant.node),
												})
											})
										}
									>
										{grant.effect}: {grant.node} ×
									</Badge>
								))}
							</Group>
						</Stack>
					))}
				</Stack>
			</Card>
		</Stack>
	)
}
