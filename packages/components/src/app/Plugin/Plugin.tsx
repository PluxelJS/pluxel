// PluginComponents.tsx
import {
	Container,
	Grid,
	Card,
	ScrollArea,
	Box,
	Text,
	Divider,
	useMantineTheme,
	TableOfContents,
} from '@mantine/core'
import { ActionBar } from './ActionBar'
import { PluginInfo, type PluginInfoProps } from './PluginInfo'
import type { ReactNode } from 'react'

export interface PluginProps {
	info: PluginInfoProps
	links?: { label: string; url: string }[]
	license?: { name: string; url: string }
	tocRecords?: { value: string; label: string; children?: any[] }[]
	children: ReactNode
}

export function Plugin({
	info,
	links = [],
	license,
	tocRecords = [],
	children,
}: PluginProps) {
	const theme = useMantineTheme()

	return (
		<Container size="lg" py="md">
			{/* 顶部操作栏 */}
			{/* <ActionBar /> */}

			{/* 两栏布局：左侧粘性，右侧滚动 */}
			<Grid mt="md">
				{/* 左侧信息 + 目录 */}
				<Grid.Col span={4}>
					<Box
						style={{
							position: 'sticky',
							top: theme.spacing.md,
						}}
					>
						{/* 插件信息卡片 */}
						<Card shadow="sm" radius="md" p="lg" withBorder mb="md">
							<PluginInfo {...info} links={links} license={license} />
						</Card>

						{/* 可选目录卡片 */}
						{tocRecords.length > 0 && (
							<Card shadow="sm" radius="md" p="lg" withBorder>
								<Text size="sm" mb="xs">
									目录
								</Text>
								<Divider mb="sm" />
								{/* 目录滚动区 */}
								<ScrollArea
									style={{
										height: `calc(100vh - ${Number(theme.spacing.md) * 4}px)`,
									}}
									offsetScrollbars
								>
									<TableOfContents />
								</ScrollArea>
							</Card>
						)}
					</Box>
				</Grid.Col>

				{/* 右侧主内容 */}
				<Grid.Col span={8}>
					<ScrollArea.Autosize h={`calc(100vh - ${24 * 2}px)`} offsetScrollbars>
						<Card shadow="sm" radius="md" p="lg" withBorder>
							<Box px="sm" py="xs" style={{ lineHeight: 1.6 }}>
								{children}
							</Box>
						</Card>
					</ScrollArea.Autosize>
				</Grid.Col>
			</Grid>
		</Container>
	)
}

export default Plugin
