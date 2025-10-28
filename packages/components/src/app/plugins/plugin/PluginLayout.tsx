import { Box, Flex } from '@mantine/core'
import { LeftPane } from './components/LeftPane'
import { RightPane } from './components/RightPane'
import type { PluginConfigState } from './hooks/usePluginConfig'

const LEFT_WIDTH = 'clamp(320px, 34vw, 480px)'

interface PluginLayoutProps {
	config: PluginConfigState
	stacked?: boolean
}

export function PluginLayout({ config, stacked = false }: PluginLayoutProps) {
	return (
		<Flex
			direction={stacked ? 'column' : 'row'}
			h={stacked ? 'auto' : '100%'}
			gap="md"
			style={{ minHeight: 0, minWidth: 0, overflow: 'hidden' }}
		>
			<Box
				style={{
					flex: stacked ? 'initial' : '0 0 auto',
					width: stacked ? '100%' : LEFT_WIDTH,
					minWidth: 0,
					minHeight: stacked ? 'auto' : 0,
					display: 'flex',
				}}
			>
				<LeftPane />
			</Box>

			<Box style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
				<RightPane config={config} />
			</Box>
		</Flex>
	)
}
