import {
	TelegramAccountPanel,
	TelegramCreatePanel,
	TelegramManagerPanel,
	TelegramOverviewPanel,
} from './panel.tsx'
import { telegramUi } from './runtime.ts'

export default telegramUi.define({
	Account: TelegramAccountPanel,
	Create: TelegramCreatePanel,
	Manager: TelegramManagerPanel,
	Overview: TelegramOverviewPanel,
})
