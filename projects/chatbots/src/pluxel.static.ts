import '@pluxel/runtime/services/vault'
import { ChatBuiltinsPlugin } from '@repo/chatbots-builtins'
import { ChatAccessPlugin } from '@repo/chatbots-access'
import { ChatCommandsPlugin } from '@repo/chatbots-commands'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { KookHubBridgePlugin } from '@repo/chatbots-kook-hub'
import { KookPlugin } from '@repo/chatbots-kook'
import { ChatSandboxPlugin } from '@repo/chatbots-sandbox'
import { TelegramHubBridgePlugin } from '@repo/chatbots-telegram-hub'
import { TelegramPlugin } from '@repo/chatbots-telegram'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { resolve } from 'node:path'
import { createChatbotsPersistence } from './persistence.ts'

export const chatbotsPlugins = [
	ChatHubPlugin,
	ChatAccessPlugin,
	ChatCommandsPlugin,
	ChatBuiltinsPlugin,
	ChatSandboxPlugin,
	TelegramPlugin,
	KookPlugin,
	TelegramHubBridgePlugin,
	KookHubBridgePlugin,
] as const

// Platform plugins stay enabled so their Vault-backed setup UI remains reachable.
// Bridges only create transports for configured Bots; connection loops still belong to each platform.
export const chatbotsEnabledPlugins = [
	'ChatHubPlugin',
	'ChatAccessPlugin',
	'ChatCommandsPlugin',
	'ChatBuiltinsPlugin',
	'ChatSandboxPlugin',
	'TelegramPlugin',
	'KookPlugin',
	'TelegramHubBridgePlugin',
	'KookHubBridgePlugin',
] as const

export default defineStaticRuntime({
	name: 'chatbots',
	plugins: chatbotsPlugins,
	configure({ env, deployment }) {
		const dataRoot = env.PLUXEL_STATIC_DATA_ROOT
			? resolve(env.PLUXEL_STATIC_DATA_ROOT)
			: resolve(deployment?.root ?? resolve(import.meta.dirname, '..'), 'data')
		return {
			// This is a fixed product catalog: capability plugins stay available so their
			// setup UI is never hidden by a stale persisted enabled list after upgrades.
			runtimeState: { mode: 'memory', snapshot: { enabled: chatbotsEnabledPlugins } },
			persistence: {
				mode: 'custom',
				backend: createChatbotsPersistence(resolve(dataRoot, 'persistence')),
			},
			workbench:
				env.PLUXEL_WORKBENCH === 'false'
					? false
					: { enabled: true, access: { exposure: 'private' } },
		}
	},
})
