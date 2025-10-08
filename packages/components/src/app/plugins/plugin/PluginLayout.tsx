import { Box } from '@mantine/core'
import { LeftPane } from './components/LeftPane'
import { RightPane } from './components/RightPane'
import type { PluginConfigState } from './hooks/usePluginConfig'

const LEFT_WIDTH = 'clamp(320px, 34vw, 480px)'

const ROW_WRAP = {
	display: 'flex',
	gap: 'var(--mantine-spacing-md)',
	minHeight: 0,
	minWidth: 0,
	overflow: 'hidden',
}

const FLEX_1 = { flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }
const FLEX_0_LEFT = {
	flex: '0 0 auto',
	width: LEFT_WIDTH,
	minWidth: 0,
	minHeight: 0,
	display: 'flex',
}

interface PluginLayoutProps {
	config: PluginConfigState
}

export function PluginLayout({ config }: PluginLayoutProps) {
	return (
		<Box h="100%" style={{ ...ROW_WRAP }}>
			<Box style={{ ...FLEX_0_LEFT }}>
				<LeftPane />
			</Box>

			<Box style={{ ...FLEX_1 }}>
				<RightPane config={config} />
			</Box>
		</Box>
	)
}
