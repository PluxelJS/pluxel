import {
	ActionIcon,
	Badge,
	Button,
	Checkbox,
	Divider,
	Group,
	Loader,
	Modal,
	Paper,
	ScrollArea,
	Stack,
	Tabs,
	Text,
	TextInput,
	Textarea,
	UnstyledButton,
} from '@mantine/core'
import { IconPlus, IconRefresh, IconSearch, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	type AgentToolsAdminSnapshot,
	type AgentToolsPolicyInput,
	getRuntimeTransportClient,
	rpcErrorMessage,
} from '../../runtime'
import { EmptyState, ErrorState } from '../../components'
import { useNotify } from '../hooks/useNotify'

type CreateKind = 'toolset' | 'agent'
type MutablePolicy = {
	toolsets: Array<{
		id: string
		label: string
		description?: string
		commandNames: string[]
	}>
	agents: Array<{
		agentId: string
		label: string
		toolsetIds: string[]
	}>
}

const machineIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/

export function AgentToolsScreen() {
	const notify = useNotify()
	const transport = getRuntimeTransportClient()
	const [snapshot, setSnapshot] = useState<AgentToolsAdminSnapshot | null>(null)
	const [draft, setDraft] = useState<MutablePolicy>({ toolsets: [], agents: [] })
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [activeToolsetId, setActiveToolsetId] = useState<string | null>(null)
	const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
	const [commandSearch, setCommandSearch] = useState('')
	const [createKind, setCreateKind] = useState<CreateKind | null>(null)
	const [createId, setCreateId] = useState('')
	const [createLabel, setCreateLabel] = useState('')

	const applySnapshot = useCallback((next: AgentToolsAdminSnapshot) => {
		setSnapshot(next)
		setDraft(clonePolicy(next.policy))
		setActiveToolsetId((current) =>
			next.policy.toolsets.some((item) => item.id === current)
				? current
				: (next.policy.toolsets[0]?.id ?? null),
		)
		setActiveAgentId((current) =>
			next.policy.agents.some((item) => item.agentId === current)
				? current
				: (next.policy.agents[0]?.agentId ?? null),
		)
	}, [])

	const refresh = useCallback(async () => {
		setError(null)
		try {
			const next = await transport.withRpc((rpc) => rpc.agentTools().snapshot())
			applySnapshot(next)
		} catch (cause) {
			setError(rpcErrorMessage(cause, '无法读取 Agent 工具策略'))
		} finally {
			setLoading(false)
		}
	}, [applySnapshot, transport])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const dirty = useMemo(
		() => snapshot !== null && JSON.stringify(draft) !== JSON.stringify(snapshot.policy),
		[draft, snapshot],
	)
	const activeToolset = draft.toolsets.find((item) => item.id === activeToolsetId) ?? null
	const activeAgent = draft.agents.find((item) => item.agentId === activeAgentId) ?? null
	const catalogNames = useMemo(
		() => new Set(snapshot?.commands.map((command) => command.name)),
		[snapshot?.commands],
	)
	const filteredCommands = useMemo(() => {
		const term = commandSearch.trim().toLowerCase()
		if (!snapshot) return []
		if (!term) return snapshot.commands
		return snapshot.commands.filter(
			(command) =>
				command.name.toLowerCase().includes(term) ||
				command.title?.toLowerCase().includes(term) ||
				command.description.toLowerCase().includes(term),
		)
	}, [commandSearch, snapshot])

	async function save() {
		if (!snapshot || !dirty) return
		setSaving(true)
		try {
			const next = await transport.withRpc((rpc) =>
				rpc.agentTools().replacePolicy(snapshot.revision, draft as AgentToolsPolicyInput),
			)
			applySnapshot(next)
			notify({ color: 'green', message: 'Agent 工具策略已保存' })
		} catch (cause) {
			notify({ color: 'red', message: rpcErrorMessage(cause, '保存 Agent 工具策略失败') })
		} finally {
			setSaving(false)
		}
	}

	function updateToolset(
		id: string,
		update: (item: MutablePolicy['toolsets'][number]) => MutablePolicy['toolsets'][number],
	) {
		setDraft((current) => ({
			...current,
			toolsets: current.toolsets.map((item) => (item.id === id ? update(item) : item)),
		}))
	}

	function updateAgent(
		agentId: string,
		update: (item: MutablePolicy['agents'][number]) => MutablePolicy['agents'][number],
	) {
		setDraft((current) => ({
			...current,
			agents: current.agents.map((item) => (item.agentId === agentId ? update(item) : item)),
		}))
	}

	function toggleCommand(name: string, checked: boolean) {
		if (!activeToolset) return
		updateToolset(activeToolset.id, (item) => ({
			...item,
			commandNames: checked
				? [...new Set([...item.commandNames, name])].sort()
				: item.commandNames.filter((candidate) => candidate !== name),
		}))
	}

	function toggleToolset(id: string, checked: boolean) {
		if (!activeAgent) return
		updateAgent(activeAgent.agentId, (item) => ({
			...item,
			toolsetIds: checked
				? [...new Set([...item.toolsetIds, id])]
				: item.toolsetIds.filter((candidate) => candidate !== id),
		}))
	}

	function openCreate(kind: CreateKind) {
		setCreateKind(kind)
		setCreateId('')
		setCreateLabel('')
	}

	function confirmCreate() {
		const id = createId.trim()
		const label = createLabel.trim()
		if (!machineIdPattern.test(id) || !label) return
		if (createKind === 'toolset') {
			if (draft.toolsets.some((item) => item.id === id)) return
			setDraft((current) => ({
				...current,
				toolsets: [...current.toolsets, { id, label, commandNames: [] }],
			}))
			setActiveToolsetId(id)
		} else if (createKind === 'agent') {
			if (draft.agents.some((item) => item.agentId === id)) return
			setDraft((current) => ({
				...current,
				agents: [...current.agents, { agentId: id, label, toolsetIds: [] }],
			}))
			setActiveAgentId(id)
		}
		setCreateKind(null)
	}

	function deleteToolset(id: string) {
		if (!window.confirm('删除这个工具集？所有 Agent 的对应分配也会移除。')) return
		setDraft((current) => ({
			toolsets: current.toolsets.filter((item) => item.id !== id),
			agents: current.agents.map((agent) => ({
				...agent,
				toolsetIds: agent.toolsetIds.filter((toolsetId) => toolsetId !== id),
			})),
		}))
		setActiveToolsetId(draft.toolsets.find((item) => item.id !== id)?.id ?? null)
	}

	function deleteAgent(agentId: string) {
		if (!window.confirm('删除这个 Agent 分配？')) return
		setDraft((current) => ({
			...current,
			agents: current.agents.filter((item) => item.agentId !== agentId),
		}))
		setActiveAgentId(draft.agents.find((item) => item.agentId !== agentId)?.agentId ?? null)
	}

	if (loading) {
		return (
			<Group justify="center" p="xl">
				<Loader size="sm" />
				<Text c="dimmed">正在加载 Agent 工具策略</Text>
			</Group>
		)
	}
	if (error || !snapshot) {
		return (
			<ErrorState
				title="Agent 工具策略不可用"
				message={error ?? 'Runtime 未返回工具策略。'}
				onRetry={() => void refresh()}
			/>
		)
	}

	return (
		<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
			<Group justify="space-between">
				<Group gap="xs">
					<Badge variant="light">{snapshot.commands.length} commands</Badge>
					<Badge variant="light">{draft.toolsets.length} toolsets</Badge>
					<Badge variant="light">{draft.agents.length} agents</Badge>
					<Badge color={snapshot.writable ? 'green' : 'orange'} variant="light">
						{snapshot.persistence}
					</Badge>
				</Group>
				<Group gap="xs">
					<Button
						leftSection={<IconRefresh size={16} />}
						variant="default"
						onClick={() => void refresh()}
					>
						重新加载
					</Button>
					<Button
						disabled={!dirty || !snapshot.writable}
						loading={saving}
						onClick={() => void save()}
					>
						保存策略
					</Button>
				</Group>
			</Group>
			{snapshot.loadError ? (
				<Paper p="sm" withBorder>
					<Text c="red" size="sm">
						持久化策略读取失败，当前为安全拒绝状态：{snapshot.loadError}
					</Text>
				</Paper>
			) : null}
			<Tabs defaultValue="toolsets" style={{ flex: 1, minHeight: 0 }}>
				<Tabs.List>
					<Tabs.Tab value="toolsets">工具集</Tabs.Tab>
					<Tabs.Tab value="agents">Agent 分配</Tabs.Tab>
				</Tabs.List>
				<Tabs.Panel value="toolsets" pt="sm" style={{ height: 'calc(100% - 42px)' }}>
					<Group align="stretch" gap="sm" h="100%" wrap="nowrap">
						<PolicyList
							title="工具集"
							items={draft.toolsets.map((item) => ({
								id: item.id,
								label: item.label,
								meta: `${item.commandNames.length} commands`,
							}))}
							activeId={activeToolsetId}
							onAdd={() => openCreate('toolset')}
							onSelect={setActiveToolsetId}
						/>
						<Paper p="md" withBorder style={{ flex: 1, minWidth: 0 }}>
							{activeToolset ? (
								<Stack h="100%" gap="sm">
									<Group justify="space-between">
										<Badge variant="outline">{activeToolset.id}</Badge>
										<ActionIcon
											aria-label="删除工具集"
											color="red"
											variant="subtle"
											onClick={() => deleteToolset(activeToolset.id)}
										>
											<IconTrash size={17} />
										</ActionIcon>
									</Group>
									<TextInput
										label="名称"
										value={activeToolset.label}
										onChange={(event) =>
											updateToolset(activeToolset.id, (item) => ({
												...item,
												label: event.currentTarget.value,
											}))
										}
									/>
									<Textarea
										label="说明"
										minRows={2}
										value={activeToolset.description ?? ''}
										onChange={(event) =>
											updateToolset(activeToolset.id, (item) => ({
												...item,
												description: event.currentTarget.value,
											}))
										}
									/>
									<Divider label="允许的 commands" />
									<TextInput
										leftSection={<IconSearch size={15} />}
										placeholder="搜索名称或描述"
										value={commandSearch}
										onChange={(event) => setCommandSearch(event.currentTarget.value)}
									/>
									<ScrollArea style={{ flex: 1 }}>
										<Stack gap={6} pr="xs">
											{activeToolset.commandNames
												.filter((name) => !catalogNames.has(name))
												.map((name) => (
													<Checkbox
														key={name}
														checked
														color="orange"
														label={`${name}（当前不可用）`}
														onChange={(event) => toggleCommand(name, event.currentTarget.checked)}
													/>
												))}
											{filteredCommands.map((command) => (
												<Paper key={command.name} p="xs" withBorder>
													<Checkbox
														checked={activeToolset.commandNames.includes(command.name)}
														label={
															<Stack gap={2}>
																<Group gap="xs">
																	<Text fw={600} size="sm">
																		{command.title ?? command.name}
																	</Text>
																	<Badge
																		color={command.behavior.kind === 'query' ? 'blue' : 'orange'}
																		size="xs"
																		variant="light"
																	>
																		{command.behavior.kind}
																	</Badge>
																</Group>
																<Text c="dimmed" ff="monospace" size="xs">
																	{command.name}
																</Text>
																<Text c="dimmed" lineClamp={2} size="xs">
																	{command.description}
																</Text>
															</Stack>
														}
														onChange={(event) =>
															toggleCommand(command.name, event.currentTarget.checked)
														}
													/>
												</Paper>
											))}
										</Stack>
									</ScrollArea>
								</Stack>
							) : (
								<EmptyState
									title="还没有工具集"
									description="创建工具集并选择允许投影给 Agent 的 commands。"
								/>
							)}
						</Paper>
					</Group>
				</Tabs.Panel>
				<Tabs.Panel value="agents" pt="sm" style={{ height: 'calc(100% - 42px)' }}>
					<Group align="stretch" gap="sm" h="100%" wrap="nowrap">
						<PolicyList
							title="Agent"
							items={draft.agents.map((item) => ({
								id: item.agentId,
								label: item.label,
								meta: `${item.toolsetIds.length} toolsets`,
							}))}
							activeId={activeAgentId}
							onAdd={() => openCreate('agent')}
							onSelect={setActiveAgentId}
						/>
						<Paper p="md" withBorder style={{ flex: 1, minWidth: 0 }}>
							{activeAgent ? (
								<Stack gap="sm">
									<Group justify="space-between">
										<Badge variant="outline">{activeAgent.agentId}</Badge>
										<ActionIcon
											aria-label="删除 Agent 分配"
											color="red"
											variant="subtle"
											onClick={() => deleteAgent(activeAgent.agentId)}
										>
											<IconTrash size={17} />
										</ActionIcon>
									</Group>
									<TextInput
										label="显示名称"
										value={activeAgent.label}
										onChange={(event) =>
											updateAgent(activeAgent.agentId, (item) => ({
												...item,
												label: event.currentTarget.value,
											}))
										}
									/>
									<Divider label="分配工具集" />
									{draft.toolsets.length > 0 ? (
										<Stack gap="xs">
											{draft.toolsets.map((toolset) => (
												<Paper key={toolset.id} p="sm" withBorder>
													<Checkbox
														checked={activeAgent.toolsetIds.includes(toolset.id)}
														label={
															<Group justify="space-between" wrap="nowrap">
																<Stack gap={1}>
																	<Text fw={600} size="sm">
																		{toolset.label}
																	</Text>
																	<Text c="dimmed" ff="monospace" size="xs">
																		{toolset.id}
																	</Text>
																</Stack>
																<Badge variant="light">{toolset.commandNames.length}</Badge>
															</Group>
														}
														onChange={(event) =>
															toggleToolset(toolset.id, event.currentTarget.checked)
														}
													/>
												</Paper>
											))}
										</Stack>
									) : (
										<EmptyState title="没有可分配的工具集" description="先创建至少一个工具集。" />
									)}
								</Stack>
							) : (
								<EmptyState
									title="还没有 Agent"
									description="创建稳定 Agent ID，再为它分配工具集。"
								/>
							)}
						</Paper>
					</Group>
				</Tabs.Panel>
			</Tabs>
			<Modal
				opened={createKind !== null}
				onClose={() => setCreateKind(null)}
				title={createKind === 'toolset' ? '新建工具集' : '新建 Agent 分配'}
			>
				<Stack>
					<TextInput
						autoFocus
						description="稳定机器标识；创建后不应随显示名称变化"
						error={
							createId && !machineIdPattern.test(createId)
								? '只允许字母、数字、._:-，最长 128'
								: undefined
						}
						label={createKind === 'toolset' ? 'Toolset ID' : 'Agent ID'}
						value={createId}
						onChange={(event) => setCreateId(event.currentTarget.value)}
					/>
					<TextInput
						label="显示名称"
						value={createLabel}
						onChange={(event) => setCreateLabel(event.currentTarget.value)}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setCreateKind(null)}>
							取消
						</Button>
						<Button
							disabled={!machineIdPattern.test(createId.trim()) || !createLabel.trim()}
							onClick={confirmCreate}
						>
							创建
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	)
}

function PolicyList(props: {
	title: string
	items: Array<{ id: string; label: string; meta: string }>
	activeId: string | null
	onAdd(): void
	onSelect(id: string): void
}) {
	return (
		<Paper p="sm" withBorder w={260} style={{ flexShrink: 0 }}>
			<Stack h="100%" gap="xs">
				<Group justify="space-between">
					<Text fw={700}>{props.title}</Text>
					<ActionIcon aria-label={`新建${props.title}`} variant="light" onClick={props.onAdd}>
						<IconPlus size={17} />
					</ActionIcon>
				</Group>
				<ScrollArea style={{ flex: 1 }}>
					<Stack gap={4}>
						{props.items.map((item) => (
							<UnstyledButton key={item.id} onClick={() => props.onSelect(item.id)}>
								<Paper
									bg={props.activeId === item.id ? 'var(--mantine-color-blue-light)' : undefined}
									p="xs"
									withBorder
								>
									<Text fw={600} lineClamp={1} size="sm">
										{item.label}
									</Text>
									<Text c="dimmed" lineClamp={1} size="xs">
										{item.id} · {item.meta}
									</Text>
								</Paper>
							</UnstyledButton>
						))}
					</Stack>
				</ScrollArea>
			</Stack>
		</Paper>
	)
}

function clonePolicy(policy: AgentToolsPolicyInput): MutablePolicy {
	return {
		toolsets: policy.toolsets.map((item) => ({
			id: item.id,
			label: item.label,
			...(item.description ? { description: item.description } : {}),
			commandNames: [...item.commandNames],
		})),
		agents: policy.agents.map((item) => ({
			agentId: item.agentId,
			label: item.label,
			toolsetIds: [...item.toolsetIds],
		})),
	}
}
