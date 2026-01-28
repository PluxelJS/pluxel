import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Indicator,
	Popover,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	useComputedColorScheme,
} from '@mantine/core'
import { IconArrowRight, IconBell, IconMenu2, IconSearch } from '@tabler/icons-react'
import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ColorSchemeToggle } from '../components'
import { ExtensionSlot } from '../extension'
import { PLUGIN_SEARCH_EVENT, PLUGIN_SEARCH_KEY } from './constants'
import { useNotify } from './hooks'
import { useNotificationCenter } from './notifications/NotificationCenterProvider'
import { useCurrentPathname } from './router/useCurrentRoute'

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
	const notify = useNotify()
	const router = useRouter()
	const pathname = useCurrentPathname()

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
		router.history.push('/plugins')
	}, [notify, router.history, search])

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
				<ActionIcon variant="default" size="lg" radius="xl" onClick={onMenu} aria-label="展开导航">
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
					<ActionIcon variant="subtle" size="sm" aria-label="执行搜索" onClick={handleSearchSubmit}>
						<IconArrowRight size={16} />
					</ActionIcon>
				}
				rightSectionWidth={32}
				style={{ flex: 1, maxWidth: 360 }}
				aria-label="搜索"
			/>

			<Group gap="xs" wrap="nowrap">
				{/* 扩展插槽：插件可以在这里添加按钮/徽章 */}
				<ExtensionSlot point="header:actions" />

				<ColorSchemeToggle />

				<NotificationBell />
			</Group>
		</Group>
	)
}

function NotificationBell() {
	const { items, unread, markAllRead, clear } = useNotificationCenter()
	const [opened, setOpened] = useState(false)
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const unreadBg = scheme === 'dark' ? 'rgba(91, 140, 255, 0.18)' : 'rgba(91, 140, 255, 0.1)'
	const borderColor = scheme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(15, 23, 42, 0.08)'

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
							<Button variant="subtle" size="compact-xs" onClick={markAllRead} disabled={!unread}>
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
											<Badge size="xs" variant="light" color={item.color} mt={6} w="fit-content">
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
