import { MantineProvider } from '@mantine/core'
import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { FontsWorkbench } from '../workbench.ts'
import { FontSelectionContent } from './index.tsx'

export default function FontSelectionPanel() {
	const { provider, host } = useWorkbench(FontsWorkbench.selection)
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<FontSelectionContent selection={provider} />
		</MantineProvider>
	)
}
