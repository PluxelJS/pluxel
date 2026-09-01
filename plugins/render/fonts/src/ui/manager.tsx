import { MantineProvider } from '@mantine/core'
import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { FontsWorkbench } from '../workbench.ts'
import { FontManagerContent } from './index.tsx'

export default function FontsManagerPanel() {
	const { api, host } = useWorkbench(FontsWorkbench.manager)
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<FontManagerContent fonts={api} />
		</MantineProvider>
	)
}
