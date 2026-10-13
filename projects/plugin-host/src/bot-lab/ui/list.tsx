import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	MantineProvider,
	ScrollArea,
	Select,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from '@mantine/core'
import { useMemo, useState } from 'react'
import { listScope, listSnapshot } from './list.scope'
import './list.css'

function List() {
	const { host } = listScope.useWorkbench()
	const query = listSnapshot.useQuery()
	const [search, setSearch] = useState('')
	const [source, setSource] = useState<string | null>(null)
	const [groupBy, setGroupBy] = useState<string | null>('group')
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
	const groups = useMemo(() => {
		const result = new Map<string, NonNullable<typeof query.data>['bots'][number][]>()
		const needle = search.trim().toLocaleLowerCase()
		for (const bot of query.data?.bots ?? []) {
			if (source && bot.source !== source) continue
			if (
				needle &&
				!`${bot.name} ${bot.account} ${bot.id} ${bot.source} ${bot.group}`
					.toLocaleLowerCase()
					.includes(needle)
			)
				continue
			const label =
				groupBy === 'group'
					? bot.group
					: (query.data?.sources.find((item) => item.id === bot.source)?.label ?? bot.source)
			const entries = result.get(label) ?? []
			entries.push(bot)
			result.set(label, entries)
		}
		return [...result]
	}, [query.data, search, source, groupBy])
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<Stack className="bot-lab-list" gap={6} p={8} h="100%" mih={0}>
				<TextInput
					size="xs"
					aria-label="搜索机器人"
					placeholder="名称、账号或标识"
					value={search}
					onChange={(event) => setSearch(event.currentTarget.value)}
				/>
				<Group gap={4} grow wrap="nowrap">
					<Select
						size="xs"
						aria-label="筛选来源"
						placeholder="全部来源"
						clearable
						value={source}
						onChange={setSource}
						data={(query.data?.sources ?? []).map((item) => ({
							value: item.id,
							label: item.label,
						}))}
					/>
					<Select
						size="xs"
						aria-label="列表分组"
						value={groupBy}
						onChange={setGroupBy}
						allowDeselect={false}
						data={[
							{ value: 'source', label: '按来源' },
							{ value: 'group', label: '按业务分组' },
						]}
					/>
				</Group>
				{query.isPending && <Loader size="xs" />}
				{query.error && (
					<Alert color="red" title="列表读取失败">
						{query.error instanceof Error ? query.error.message : String(query.error)}
					</Alert>
				)}
				<ScrollArea flex={1} mih={0} type="auto">
					<Stack gap={4}>
						{groups.map(([label, bots]) => (
							<section key={label}>
								<UnstyledButton
									className="bot-lab-list__group"
									aria-expanded={!!search || !collapsed.has(label)}
									onClick={() =>
										setCollapsed((previous) => {
											const next = new Set(previous)
											if (next.has(label)) next.delete(label)
											else next.add(label)
											return next
										})
									}
								>
									<Text size="xs" fw={600} truncate>
										{label}
									</Text>
									<Text size="xs" c="dimmed">
										{bots.length}
									</Text>
								</UnstyledButton>
								{(!!search || !collapsed.has(label)) &&
									bots.map((bot) => (
										<UnstyledButton
											key={`${bot.source}:${bot.id}`}
											className="bot-lab-list__bot"
											disabled={!host.navigation}
											title={`${bot.name} · ${bot.source}/${bot.id} · ${bot.account} · ${!bot.available ? '来源不可用' : bot.running ? '运行中' : '已停止'}`}
											onClick={() =>
												host.navigation?.navigate(
													`/bot-lab/${encodeURIComponent(bot.source)}/${encodeURIComponent(bot.id)}`,
												)
											}
										>
											<span
												className="bot-lab-list__dot"
												data-state={
													!bot.available ? 'unavailable' : bot.running ? 'running' : 'stopped'
												}
												aria-label={
													!bot.available ? '来源不可用' : bot.running ? '运行中' : '已停止'
												}
											/>
											<span className="bot-lab-list__identity">
												<Text size="xs" fw={500} truncate>
													{bot.name}
												</Text>
												<Text size="10px" c="dimmed" truncate>
													{bot.source} · {bot.account}
												</Text>
											</span>
											{!bot.available ? (
												<Badge size="xs" color="orange" variant="light">
													不可用
												</Badge>
											) : bot.unread > 0 ? (
												<Badge size="xs" variant="light">
													{bot.unread}
												</Badge>
											) : null}
										</UnstyledButton>
									))}
							</section>
						))}
						{query.data && groups.length === 0 && (
							<Text size="xs" c="dimmed" p="xs">
								没有匹配的机器人
							</Text>
						)}
					</Stack>
				</ScrollArea>
				<Button
					size="compact-xs"
					variant="subtle"
					onClick={() => host.navigation?.navigate('/bot-lab')}
					disabled={!host.navigation}
				>
					工作区概览
				</Button>
			</Stack>
		</MantineProvider>
	)
}
export default listScope.render(List)
