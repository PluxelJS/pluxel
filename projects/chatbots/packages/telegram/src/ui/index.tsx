import { TelegramSettingsPanel } from './panel.tsx'
import { telegramPlugin } from './runtime.ts'

export default telegramPlugin.expose({
	TelegramSettingsPanel,
	TelegramSettingsRoute: TelegramSettingsPanel,
})
