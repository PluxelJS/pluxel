import { KookSettingsPanel } from './panel.tsx'
import { kookPlugin } from './runtime.ts'

export default kookPlugin.expose({
	KookSettingsPanel,
	KookSettingsRoute: KookSettingsPanel,
})
