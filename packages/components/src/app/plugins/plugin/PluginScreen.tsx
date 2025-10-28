import {
	Box,
	Button,
	Card,
	CardSection,
	Center,
	Flex,
	Skeleton,
	Stack,
	Text,
	useMantineTheme,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { memo, useCallback, useMemo } from 'react'
import type { PluginScope } from '../../gqty'
import { useQuery } from '../../gqty'
import { PluginScopeProvider } from './context'
import { useDebouncedFlag } from './hooks/useDebouncedFlag'
import { usePluginConfig } from './hooks/usePluginConfig'
import { PluginLayout } from './PluginLayout'
import { toDependencySnapshots } from './utils'

const LEFT_SKELETON_WIDTH = 'clamp(320px, 34vw, 480px)'

function PluginSkeleton({ stacked }: { stacked: boolean }) {
	return (
		<Flex
			direction={stacked ? 'column' : 'row'}
			gap="md"
			h={stacked ? 'auto' : '100%'}
			style={{ minHeight: 0, minWidth: 0 }}
		>
			<Card
				withBorder
				shadow="sm"
				style={{
					flex: stacked ? 'initial' : '0 0 auto',
					width: stacked ? '100%' : LEFT_SKELETON_WIDTH,
					minWidth: 0,
					minHeight: stacked ? 'auto' : '100%',
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				<CardSection withBorder px="md" py="sm">
					<Stack gap={8}>
						<Skeleton height={24} width="60%" radius="sm" />
						<Flex gap={8}>
							<Skeleton height={20} width={88} radius="xl" />
							<Skeleton height={20} width={88} radius="xl" />
						</Flex>
					</Stack>
				</CardSection>
				<CardSection px="md" py="sm" style={{ flex: 1 }}>
					<Stack gap="sm" h="100%">
						<Skeleton height={14} width="90%" />
						<Skeleton height={14} width="75%" />
						<Skeleton height={14} width="82%" />
						<Skeleton height="100%" radius="md" />
					</Stack>
				</CardSection>
			</Card>

			<Card
				withBorder
				shadow="sm"
				style={{
					flex: 1,
					minWidth: 0,
					minHeight: stacked ? 260 : '100%',
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				<CardSection withBorder px="md" py="sm">
					<Skeleton height={22} width="30%" radius="sm" />
				</CardSection>
				<CardSection px="md" py="sm" style={{ flex: 1 }}>
					<Stack gap="sm" h="100%">
						<Skeleton height={14} width="92%" />
						<Skeleton height={14} width="86%" />
						<Skeleton height="100%" radius="md" />
					</Stack>
				</CardSection>
			</Card>
		</Flex>
	)
}

export interface PluginScreenProps {
	pluginName: string
}

export const PluginScreen = memo(function PluginScreen({ pluginName }: PluginScreenProps) {
	const theme = useMantineTheme()
	const breakpointLg = theme.breakpoints?.lg ?? '62em'
	const mediaQuery =
		typeof breakpointLg === 'number'
			? `(max-width: ${breakpointLg}px)`
			: `(max-width: ${breakpointLg})`
	const isStacked = useMediaQuery(mediaQuery, false, {
		getInitialValueInEffect: true,
	})
	const query = useQuery({
		suspense: false,
		operationName: 'PluginDetailView',
		notifyOnNetworkStatusChange: true,
		refetchOnWindowVisible: false,
		refetchOnReconnect: false,
		prepare: pluginName
			? ({ query }) => {
					const scope = query.plugin({ name: pluginName })
					scope.name
					const detail = scope.detail
					detail.desc
					detail.dependencies.map((dep) => {
						dep.name
						dep.isRunning
					})
					scope.status.isRunning
				}
			: undefined,
	})

	const scope: PluginScope | undefined = pluginName ? query.plugin({ name: pluginName }) : undefined
	const ready = Boolean(scope?.name)
	const displayName = scope?.name ?? pluginName
	const dependencies = useMemo(
		() => toDependencySnapshots(scope?.detail?.dependencies),
		[scope?.detail?.dependencies],
	)
	const description = scope?.detail?.desc ?? ''
	const isRunning = Boolean(scope?.status?.isRunning)
	const configState = usePluginConfig(ready ? displayName : undefined)
	const syncing = useDebouncedFlag(
		query.$state.isLoading || query.$state.isRefetching || configState.loading,
		160,
	)

	const refetch = useCallback(async () => {
		await query.$refetch(true)
	}, [query])
	const contextValue = useMemo(
		() => ({
			pluginName: displayName,
			description,
			scope,
			dependencies,
			isRunning,
			isSyncing: syncing,
			refetch,
		}),
		[dependencies, description, displayName, isRunning, refetch, scope, syncing],
	)

	if (!pluginName) {
		return (
			<Center h="100%">
				<Text c="dimmed" size="lg">
					请选择一个插件以查看详情
				</Text>
			</Center>
		)
	}

	if (query.$state.error && !ready) {
		return (
			<Center h="100%" style={{ gap: 12, flexDirection: 'column' }}>
				<Text c="red">{query.$state.error.message || '加载失败，请重试'}</Text>
				<Button size="xs" onClick={() => void query.$refetch(true)}>
					重试
				</Button>
			</Center>
		)
	}

	if (!ready) return <PluginSkeleton stacked={Boolean(isStacked)} />

	if (!scope) return null

	return (
		<PluginScopeProvider value={contextValue}>
			<PluginLayout config={configState} stacked={Boolean(isStacked)} />
		</PluginScopeProvider>
	)
})
