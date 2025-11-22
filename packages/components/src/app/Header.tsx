import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Indicator,
	Menu,
	Popover,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Tooltip,
	Box,
	useComputedColorScheme,
} from '@mantine/core'
import { IconArrowRight, IconBell, IconDotsVertical, IconMenu2, IconSearch } from '@tabler/icons-react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { ColorSchemeToggle } from '../components'
import { useMutation as useGqtyMutation } from './gqty'
import { useNotify } from './notifications/useNotify'
import { useNotificationCenter } from './notifications/NotificationCenterProvider'
import { PLUGIN_SEARCH_EVENT, PLUGIN_SEARCH_KEY } from './constants'

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
})

function formatTime(ts: number) {
	try {
		return timeFormatter.format(ts)
	} catch {
		return new Date(ts).toLocaleString()
	}
}

export function Header({ onMenu }: { onMenu: () => void }) {
	const [search, setSearch] = useState('')
	const searchInputRef = useRef<HTMLInputElement | null>(null)
	const [buildSnapshot, buildState] = useGqtyMutation((mutation) => {
		const result = mutation.buildSnapshot
		result.ok
		result.error
		result.path
		return result
	})
	const notify = useNotify()
	const navigate = useNavigate()
	const pathname = useRouterState({ select: (state) => state.location.pathname })

	const handleBuild = async () => {
		try {
			const result = await buildSnapshot()
			if (!result.ok) {
				notify({
					title: '生成快照失败',
					message: result.error || '未知错误',
					color: 'red',
				})
				return
			}
			notify({
				title: '已生成快照',
				message: result.path ? `保存于：${result.path}` : '在运行目录查看文件。',
				color: 'green',
			})
		} catch (error: any) {
			notify({
				title: '生成快照失败',
				message: error?.message || '操作失败，请稍后再试',
				color: 'red',
			})
		}
	}

	const handleSearchSubmit = useCallback(() => {
		const value = search.trim()
		if (!value) {
			notify({
				title: '请输入关键词',
				message: '搜索插件、包或日志时至少输入一个字符。',
				color: 'yellow',
			})
			return
		}
		if (typeof window !== 'undefined') {
			try {
				window.localStorage.setItem(PLUGIN_SEARCH_KEY, value)
			} catch {}
			window.dispatchEvent(new CustomEvent<string>(PLUGIN_SEARCH_EVENT, { detail: value }))
		}
		navigate({ to: '/plugins' as never })
	}, [navigate, notify, search])

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null
			const tag = target?.tagName?.toLowerCase()
			if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return

			const isModF = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f'
			const isSlash = event.key === '/'
			if (!isModF && !isSlash) return
			if (pathname?.startsWith('/plugins') && isModF) return
			event.preventDefault()
			searchInputRef.current?.focus()
		}
		window.addEventListener('keydown', handler)
		return () => window.removeEventListener('keydown', handler)
	}, [pathname])

	return (
		<Group h="100%" px="md" justify="space-between" gap="md" wrap="nowrap">
			<Group gap="sm" wrap="nowrap">
				<ActionIcon
					variant="default"
					size="lg"
					radius="xl"
					onClick={onMenu}
					aria-label="展开导航"
				>
					<IconMenu2 size={18} />
				</ActionIcon>
				<div style={{ minWidth: 0 }}>
					<Group gap={8} align="center">
						<Text fw={600} size="lg">
							Pluxel 控制台
						</Text>
						<Badge color="brand" variant="light">
							beta
						</Badge>
					</Group>
					<Text size="sm" c="dimmed" lh={1.4}>
						统一管理插件、日志与包的工作台
					</Text>
				</div>
			</Group>

			<TextInput
				ref={searchInputRef}
				value={search}
				onChange={(event) => setSearch(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault()
						handleSearchSubmit()
					}
				}}
				placeholder="搜索插件、包或日志"
				variant="filled"
				leftSection={<IconSearch size={16} />}
				rightSection={
					<ActionIcon
						variant="subtle"
						size="sm"
						aria-label="执行搜索"
						onClick={handleSearchSubmit}
					>
						<IconArrowRight size={16} />
					</ActionIcon>
				}
				rightSectionWidth={32}
				style={{ flex: 1, maxWidth: 360 }}
				aria-label="搜索"
			/>

			<Group gap="xs" wrap="nowrap">
				<NotificationBell />

				<ColorSchemeToggle />

				<Button onClick={handleBuild} loading={buildState.isLoading} leftSection="⚡">
					构建 SNAPSHOT
				</Button>

				<Menu withinPortal shadow="md">
					<Menu.Target>
						<ActionIcon variant="default" size="lg" radius="xl" aria-label="更多操作">
							<IconDotsVertical size={18} />
						</ActionIcon>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Label>快速操作</Menu.Label>
						<Menu.Item onClick={handleBuild}>重新构建</Menu.Item>
						<Menu.Item onClick={() => setSearch('')}>清空搜索</Menu.Item>
						<Menu.Divider />
						<Menu.Label>帮助</Menu.Label>
						<Menu.Item
							onClick={() => {
								if (typeof window !== 'undefined') {
									window.open('https://pluxel.dev', '_blank', 'noopener,noreferrer')
								}
							}}
						>
							查看文档
						</Menu.Item>
					</Menu.Dropdown>
				</Menu>
			</Group>
		</Group>
	)
}

function NotificationBell() {
	const { items, unread, markAllRead, clear } = useNotificationCenter()
	const [opened, setOpened] = useState(false)
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const unreadBg =
		scheme === 'dark' ? 'rgba(91, 140, 255, 0.18)' : 'rgba(91, 140, 255, 0.1)'
	const borderColor =
		scheme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(15, 23, 42, 0.08)'

	return (
		<Popover
			withArrow
			shadow="md"
			position="bottom-end"
			width={360}
			opened={opened}
			onChange={setOpened}
			offset={8}
		>
			<Popover.Target>
				<Indicator
					disabled={!unread}
					label={unread > 9 ? '9+' : unread}
					size={18}
					color="red"
					processing
				>
					<ActionIcon
						variant="default"
						size="lg"
						radius="xl"
						aria-label="通知中心"
						onClick={() => setOpened((o) => !o)}
					>
						<IconBell size={18} />
					</ActionIcon>
				</Indicator>
			</Popover.Target>
			<Popover.Dropdown p="sm">
				<Stack gap="xs">
					<Group justify="space-between" align="center">
						<Text fw={600}>通知中心</Text>
						<Group gap={6}>
							<Button
								variant="subtle"
								size="compact-xs"
								onClick={markAllRead}
								disabled={!unread}
							>
								全部已读
							</Button>
							<Button
								variant="subtle"
								color="gray"
								size="compact-xs"
								onClick={clear}
								disabled={!items.length}
							>
								清空
							</Button>
						</Group>
					</Group>
					<ScrollArea h={260} type="auto" offsetScrollbars>
						<Stack gap="xs">
							{items.length === 0 ? (
								<Text c="dimmed" size="sm">
									暂无通知
								</Text>
							) : (
								items.map((item) => (
									<Box
										key={item.id}
										p="xs"
										style={{
											borderRadius: 8,
											border: `1px solid ${borderColor}`,
											backgroundColor: item.read ? 'transparent' : unreadBg,
										}}
									>
										<Group justify="space-between" align="flex-start" gap={6}>
											<Text fw={600} size="sm">
												{item.title || '通知'}
											</Text>
											<Text size="xs" c="dimmed">
												{formatTime(item.createdAt)}
											</Text>
										</Group>
										<Text size="sm" c="dimmed">
											{item.message || '—'}
										</Text>
										{item.color && (
											<Badge
												size="xs"
												variant="light"
												color={item.color}
												mt={6}
												w="fit-content"
											>
												{item.color}
											</Badge>
										)}
									</Box>
								))
							)}
						</Stack>
					</ScrollArea>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	)
}
