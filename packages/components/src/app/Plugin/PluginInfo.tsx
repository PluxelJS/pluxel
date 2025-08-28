// PluginInfo.tsx
import { Anchor, Badge, Box, Divider, Group, SimpleGrid, Text, Title } from '@mantine/core'
import { IconCertificate, IconInfoCircle, IconLink, IconUser } from '@tabler/icons-react'

export interface PluginInfoProps {
	name: string
	description: string
	author: string
	version: string
	info?: { label: string; value: string }[]
	links?: { label: string; url: string }[]
	license?: { name: string; url: string }
}

export function PluginInfo({
	name,
	description,
	author,
	version,
	info = [],
	links = [],
	license,
}: PluginInfoProps) {
	return (
		<Box>
			{/* 名称与许可证 */}
			<Group align="center">
				<Title order={4}>{name}</Title>
				{license && (
					<Anchor href={license.url} size="xs" target="_blank">
						<Group gap={4} align="center">
							<IconCertificate size={16} />
							<Text size="xs">{license.name}</Text>
						</Group>
					</Anchor>
				)}
			</Group>

			{/* 描述 */}
			<Text size="sm" color="dimmed" mt="xs" lineClamp={3}>
				{description}
			</Text>

			{/* 版本 & 作者 */}
			<Group mt="xs" gap="xs">
				<Badge variant="light" size="sm">
					v{version}
				</Badge>
				<Group gap={4} align="center">
					<IconUser size={14} />
					<Text size="xs">{author}</Text>
				</Group>
			</Group>

			{/* 额外信息 */}
			{info.length > 0 && (
				<>
					<Divider my="sm" />
					<SimpleGrid cols={2} spacing="xs">
						{info.map((item, idx) => (
							<Group key={idx} gap={4} align="center">
								<IconInfoCircle size={12} />
								<Text size="xs" w={500}>
									{item.label}:
								</Text>
								<Text size="xs" color="dimmed">
									{item.value}
								</Text>
							</Group>
						))}
					</SimpleGrid>
				</>
			)}

			{/* 链接列表 */}
			{links.length > 0 && (
				<>
					<Divider my="sm" />
					<Box>
						<Text size="sm" w={500} mb="xs">
							相关链接
						</Text>
						<SimpleGrid cols={1} spacing="xs">
							{links.map((link, idx) => (
								<Anchor key={idx} href={link.url} size="sm" lineClamp={1} target="_blank">
									<Group gap={4} align="center">
										<IconLink size={12} />
										<Text size="xs">{link.label}</Text>
									</Group>
								</Anchor>
							))}
						</SimpleGrid>
					</Box>
				</>
			)}
		</Box>
	)
}
