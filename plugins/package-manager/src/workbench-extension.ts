import { workbench, type WorkbenchExtension } from '@pluxel/runtime/workbench'
import { PackageManagerWorkbenchUi } from './workbench-contract.ts'

export const PackageManagerWorkbench: WorkbenchExtension<typeof PackageManagerWorkbenchUi> =
	workbench.extension({
		contract: PackageManagerWorkbenchUi,
		entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	})
