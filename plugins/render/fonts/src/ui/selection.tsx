import { WorkbenchMantineProvider } from '@pluxel/workbench/mantine'
import { FontSelectionContent } from './index.tsx'
import { fontSelectionQuery, selectionScope, setPreferredFontMutation } from './selection.scope.ts'

function FontSelectionPanel() {
	const { host } = selectionScope.useWorkbench()
	const selection = fontSelectionQuery.useQuery()
	const setPreferredFont = setPreferredFontMutation.useMutation()
	return (
		<WorkbenchMantineProvider colorScheme={host.colorScheme}>
			<FontSelectionContent
				snapshot={selection.data}
				loading={selection.isPending || selection.isFetching}
				saving={setPreferredFont.isPending}
				error={
					setPreferredFont.status === 'error'
						? setPreferredFont.error
						: selection.status === 'error'
							? selection.error
							: null
				}
				onRefresh={() => {
					setPreferredFont.reset()
					selection.invalidate()
				}}
				onPreferredFamilyChange={(family) => {
					setPreferredFont.reset()
					setPreferredFont.mutate(family)
				}}
			/>
		</WorkbenchMantineProvider>
	)
}

export default selectionScope.render(FontSelectionPanel)
