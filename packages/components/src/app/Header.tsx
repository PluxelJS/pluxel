import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Menu,
	Text,
	TextInput,
	Tooltip,
} from '@mantine/core'
import { showNotification } from '@mantine/notifications'
import { IconBell, IconDotsVertical, IconMenu2, IconSearch } from '@tabler/icons-react'
import { useState } from 'react'
import { ColorSchemeToggle } from '../components'
import { useMutation as useGqtyMutation } from './gqty'

export function Header({ onMenu }: { onMenu: () => void }) {
	const [search, setSearch] = useState('')
	const [buildSnapshot, buildState] = useGqtyMutation((mutation) => {
		const result = mutation.buildSnapshot
		result.ok
		result.error
		result.path
		return result
	})

	const handleBuild = async () => {
		try {
			const result = await buildSnapshot()
			if (!result.ok) {
				showNotification({
					title: '生成快照失败',
					message: result.error || '未知错误',
					color: 'red',
				})
				return
			}
			showNotification({
				title: '已生成快照',
				message: result.path ? `保存于：${result.path}` : '在运行目录查看文件.',
			})
		} catch (error: any) {
			showNotification({
				title: '生成快照失败',
				message: error?.message || '操作失败，请稍后再试',
				color: 'red',
			})
		}
	}

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
				value={search}
				onChange={(event) => setSearch(event.currentTarget.value)}
				placeholder="搜索插件、包或日志"
				variant="filled"
				leftSection={<IconSearch size={16} />}
				style={{ flex: 1, maxWidth: 360 }}
				aria-label="搜索"
			/>

			<Group gap="xs" wrap="nowrap">
				<Tooltip label="通知中心">
					<ActionIcon variant="default" size="lg" radius="xl" aria-label="通知中心">
						<IconBell size={18} />
					</ActionIcon>
				</Tooltip>

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
