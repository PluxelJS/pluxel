import { Box, Flex } from '@mantine/core'
import { LeftPane } from './LeftPane'
import { RightPane } from './RightPane'
import type { PluginConfigState } from '../../hooks'

const LEFT_WIDTH = 'clamp(320px, 32vw, 440px)'

interface PluginLayoutProps {
	config: PluginConfigState
	stacked?: boolean
}

export function PluginLayout({ config, stacked = false }: PluginLayoutProps) {
	return (
		<Flex
			direction={stacked ? 'column' : 'row'}
			gap="md"
			align="stretch"
			style={{ flex: 1, minHeight: 0, minWidth: 0 }}
		>
			<Box
				style={{
					flex: stacked ? 'initial' : '0 0 auto',
					width: stacked ? '100%' : LEFT_WIDTH,
					minWidth: 0,
					minHeight: stacked ? 'auto' : '100%',
					display: 'flex',
				}}
			>
				<LeftPane compact={stacked} />
			</Box>

			<Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
				<RightPane config={config} />
			</Box>
		</Flex>
	)
}
