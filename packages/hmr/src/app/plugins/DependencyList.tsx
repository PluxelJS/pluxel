import { Anchor, Card, Group, Text, Tooltip } from '@mantine/core'
import { IconArrowRight } from '@tabler/icons-react'
import type React from 'react'
import type { Dependencies } from './Plugin'

interface DependencyListProps {
	/** 依赖项数组 */
	dependencies?: Dependencies
	/** 路由组件适配器，需支持 to & children */
	LinkComponent: React.ElementType<{ to: string; children: React.ReactNode }>
	/** 容器标题，可选 */
	title?: string
}

/**
 * 条状依赖列表组件
 * - 横向排列，高信息密度
 * - 可高亮 optional 项
 * - 点击即跳转，仅负责链接
 */
export const DependencyList: React.FC<DependencyListProps> = ({
	dependencies,
	LinkComponent,
	title = 'Dependencies',
}) => {
	if (!dependencies || dependencies.length === 0) {
		return (
			<Text color="dimmed" size="sm">
				暂无依赖项
			</Text>
		)
	}

	return (
		<Card shadow="xs" radius="md" p="xs">
			{title && (
				<Text w={600} size="sm" mb="xs">
					{title}
				</Text>
			)}
			<Group gap={4}>
				{dependencies.map((dep, idx) =>
					dep ? (
						<Tooltip
							key={dep.name || idx}
							label={dep.optional ? '可选依赖' : ''}
							position="bottom"
							withArrow
							disabled={!dep.optional}
						>
							<Anchor
								component={LinkComponent as any}
								to={dep.name}
								style={(theme) => ({
									display: 'flex',
									alignItems: 'center',
									padding: '4px 8px',
									backgroundColor: dep.optional ? theme.colors.yellow[1] : theme.colors.gray[1],
									borderRadius: theme.radius.sm,
									textDecoration: 'none',
									fontSize: theme.fontSizes.xs,
									fontWeight: dep.optional ? 600 : 500,
									color: dep.optional ? theme.colors.yellow[9] : theme.colors.blue[7],
									'&:hover': {
										backgroundColor: dep.optional ? theme.colors.yellow[2] : theme.colors.gray[2],
									},
								})}
							>
								<Text span mr={4}>
									{dep.name}
								</Text>
								<IconArrowRight size={12} />
							</Anchor>
						</Tooltip>
					) : null,
				)}
			</Group>
		</Card>
	)
}
