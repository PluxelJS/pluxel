import { Box, useMantineTheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { LeftPane } from './LeftPane'
import { RightPane } from './RightPane'
import type { PluginConfigState } from '../../hooks'

interface PluginLayoutProps {
	config: PluginConfigState
	stacked?: boolean
}

export function PluginLayout({ config, stacked = false }: PluginLayoutProps) {
	const theme = useMantineTheme()
	const isUltraNarrow = useMediaQuery(`(max-width: ${theme.breakpoints?.md ? `${theme.breakpoints.md}px` : '62em'})`, false, {
		getInitialValueInEffect: true,
	})
	const effectiveStacked = stacked || isUltraNarrow
	const leftMin = 340
	const leftMax = 460
	const columns = effectiveStacked ? '1fr' : `minmax(${leftMin}px, ${leftMax}px) minmax(0, 1fr)`

	return (
		<Box
			style={{
				display: 'grid',
				gridTemplateColumns: columns,
				gridAutoRows: effectiveStacked ? 'auto' : 'minmax(0, 1fr)',
				gap: 'var(--mantine-spacing-md)',
				alignItems: 'stretch',
				flex: 1,
				minHeight: 0,
				minWidth: 0,
			}}
		>
			<Box style={{ minWidth: 0, minHeight: 0, display: 'flex' }}>
				<LeftPane compact={effectiveStacked} />
			</Box>

			<Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
				<RightPane config={config} />
			</Box>
		</Box>
	)
}
