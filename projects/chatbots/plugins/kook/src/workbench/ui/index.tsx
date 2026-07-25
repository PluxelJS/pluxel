import { KookAccountPanel, KookCreatePanel, KookManagerPanel, KookOverviewPanel } from './panel.tsx'
import { kookUi } from './runtime.ts'

export default kookUi.define({
	Account: KookAccountPanel,
	Create: KookCreatePanel,
	Manager: KookManagerPanel,
	Overview: KookOverviewPanel,
})
