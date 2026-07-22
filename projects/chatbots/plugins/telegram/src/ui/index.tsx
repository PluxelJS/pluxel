import { TelegramManagerPanel, TelegramOverviewPanel } from './panel.tsx'
import { telegramUi } from './runtime.ts'

export default telegramUi.define({ Manager: TelegramManagerPanel, Overview: TelegramOverviewPanel })
