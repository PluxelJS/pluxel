import {
	DiscordAccountPanel,
	DiscordCreatePanel,
	DiscordManagerPanel,
	DiscordOverviewPanel,
} from './panel.tsx'
import { discordUi } from './runtime.ts'

export default discordUi.define({
	Account: DiscordAccountPanel,
	Create: DiscordCreatePanel,
	Manager: DiscordManagerPanel,
	Overview: DiscordOverviewPanel,
})
