import {
	workbenchContract,
	type WorkbenchContract,
	type WorkbenchViewSpec,
} from '@pluxel/runtime/workbench/contract'
import { WretchWorkbenchPort } from './workbench-contract.ts'

type WretchWorkbenchViews = Readonly<{
	HttpSettings: WorkbenchViewSpec<(typeof WretchWorkbenchPort)['resources']>
}>

export const WretchWorkbenchUi: WorkbenchContract<
	Readonly<{}>,
	WretchWorkbenchViews
> = workbenchContract.define({
	resources: {},
	views: {
		HttpSettings: { accepts: WretchWorkbenchPort },
	},
})
