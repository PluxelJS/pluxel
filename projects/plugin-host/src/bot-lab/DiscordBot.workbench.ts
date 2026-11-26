import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

export type DiscordChannelChange = Readonly<{
	channelId: string | null
	expectedChannelId: string | null
}>
export interface DiscordChannelApi extends RpcTarget {
	currentDto(): { name: string; channelId: string | null }
	saveDto(
		input: DiscordChannelChange,
	): Promise<{ ok: true } | { ok: false; code: 'invalid_input' | 'conflict'; message: string }>
}

export const DiscordBotWorkbench = workbench.define(import.meta.url, {
	editor: workbench.view<DiscordChannelApi>({
		renderer: './ui/discord-channel.tsx',
		placement: { kind: 'route', path: '/discord/bots/:bot', title: 'Discord 通知频道' },
	}),
})
