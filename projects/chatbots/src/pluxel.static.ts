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
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
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
export const chatbotsEnabledPlugins = chatbotsPlugins.map((plugin) => plugin.name)

export default defineStaticRuntimeConfig({
	name: 'chatbots',
	plugins: chatbotsPlugins,
	// This is a fixed product catalog: capability plugins stay available so their
	// setup UI is never hidden by a stale persisted enabled list after upgrades.
	runtimeState: { mode: 'memory', snapshot: { enabled: chatbotsEnabledPlugins } },
	persistence: {
		mode: 'custom',
		backend: createChatbotsPersistence('data/persistence'),
	},
	logger: { preset: 'core' },
	webManagement: { enabled: true, access: { exposure: 'private' } },
})
