import '@pluxel/runtime/services/vault'
import { ChatBuiltinsPlugin } from '@repo/chatbots-builtins'
import { ChatAccessPlugin } from '@repo/chatbots-access'
import { ChatCommandsPlugin } from '@repo/chatbots-commands'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { KookAdapterPlugin } from '@repo/chatbots-kook'
import { ChatSandboxPlugin } from '@repo/chatbots-sandbox'
import { TelegramAdapterPlugin } from '@repo/chatbots-telegram'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { createChatbotsPersistence } from './persistence.ts'

export const chatbotsPlugins = [
	ChatHubPlugin,
	ChatAccessPlugin,
	ChatCommandsPlugin,
	ChatBuiltinsPlugin,
	ChatSandboxPlugin,
	TelegramAdapterPlugin,
	KookAdapterPlugin,
] as const

// Management adapters must run while unconfigured so their Vault-backed setup UI
// remains reachable. They only register a live transport after a token is saved.
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
