import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

type PackageJson = {
	dependencies?: Record<string, string>
	exports?: Record<string, unknown>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function packageJson(name: string): PackageJson {
	return JSON.parse(
		readFileSync(resolve(root, 'plugins', name, 'package.json'), 'utf8'),
	) as PackageJson
}

function packageSource(name: string): string {
	const directory = resolve(root, 'plugins', name, 'src')
	return readdirSync(directory, { recursive: true, encoding: 'utf8' })
		.filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
		.map((file) => readFileSync(resolve(directory, file), 'utf8'))
		.join('\n')
}

function sourceFile(name: string, file: string): string {
	return readFileSync(resolve(root, 'plugins', name, 'src', file), 'utf8')
}

describe('chatbots package boundaries', () => {
	it('keeps host-owned UI and bridge assembly at the project root', () => {
		const host = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageJson
		expect(host.dependencies).toMatchObject({
			'@mantine/core': 'catalog:',
			'@pluxel/wretch': 'workspace:*',
			'@repo/chatbots-kook-hub-bridge': 'workspace:*',
			'@repo/chatbots-telegram-hub-bridge': 'workspace:*',
			'@tabler/icons-react': 'catalog:',
			react: 'catalog:',
		})
	})

	it.each(['telegram', 'kook'])('%s stays independent from ChatHub contracts', (name) => {
		const manifest = packageJson(name)
		const declared = { ...manifest.dependencies, ...manifest.peerDependencies }
		expect(declared).not.toHaveProperty('@repo/chatbots-contracts')
		expect(declared).not.toHaveProperty('@repo/chatbots-hub')

		const contents = packageSource(name)
		expect(contents).not.toContain('@repo/chatbots-contracts')
		expect(contents).not.toContain('@repo/chatbots-hub')
	})

	it.each(['telegram', 'kook'])('%s uses the host-owned Wretch capability', (name) => {
		const manifest = packageJson(name)
		expect(manifest.peerDependencies).toHaveProperty('@pluxel/wretch', 'workspace:*')
		const contents = packageSource(name)
		expect(contents).toContain("from '@pluxel/wretch'")
		expect(contents).not.toContain('globalThis.fetch')
	})

	it.each(['telegram', 'kook'])('%s keeps its plugin entry as a thin composition root', (name) => {
		const plugin = sourceFile(name, 'plugin.ts')
		const manager = sourceFile(name, 'bot/manager.ts')
		const rootEntries = readdirSync(resolve(root, 'plugins', name, 'src'))
		const botEntries = readdirSync(resolve(root, 'plugins', name, 'src', 'bot'))
		expect(plugin).toContain(`from './bot/manager.ts'`)
		expect(plugin).toContain(`from './bot/bot.ts'`)
		expect(plugin).not.toContain('BotAccountStore')
		expect(plugin).not.toContain('WorkbenchProjectionStore')
		expect(plugin).not.toContain('AcknowledgedProjection')
		expect(manager).toContain('BotAccountStore')
		expect(manager).toContain('createBotRegistry')
		expect(manager).toContain('KeyedSerialExecutor')
		expect(rootEntries).not.toContain('bot.ts')
		expect(rootEntries).not.toContain('status.ts')
		expect(rootEntries).toEqual(expect.arrayContaining(['api', 'bot', 'workbench']))
		expect(botEntries).not.toContain('protocol.ts')
	})

	it.each(['telegram', 'kook'])(
		'%s owns its Workbench route inside the shared Bots navigation group',
		(name) => {
			const contract = sourceFile(name, 'workbench/contract.ts')
			const plugin = sourceFile(name, 'plugin.ts')
			expect(contract).toContain("id: 'bots'")
			expect(contract).toContain(`label: '${name === 'kook' ? 'KOOK' : 'Telegram'}'`)
			expect(plugin).toContain('this.ctx.workbench.mount')
		},
	)

	it('uses the host Workbench split adapter without coupling Bot UI to worksplit internals', () => {
		const ui = readFileSync(resolve(root, 'packages/platform-kit/src/workbench-ui.tsx'), 'utf8')
		expect(ui).toContain("from '@pluxel/components/workbench-split'")
		expect(ui).not.toContain("from '@worksplit/react'")
		expect(ui).not.toContain('ChatbotsWorkbenchPlugin')
	})

	it('keeps application Workbench persistence outside the platform kit', () => {
		const platformKit = JSON.parse(
			readFileSync(resolve(root, 'packages/platform-kit/package.json'), 'utf8'),
		) as PackageJson
		const workbenchSupport = JSON.parse(
			readFileSync(resolve(root, 'packages/workbench-support/package.json'), 'utf8'),
		) as PackageJson
		expect(platformKit.exports).not.toHaveProperty('./projection')
		expect(platformKit.exports).not.toHaveProperty('./wire-schema')
		expect(platformKit.dependencies).not.toHaveProperty('drizzle-orm')
		expect(workbenchSupport.exports).toMatchObject({
			'./projection': './src/projection.ts',
			'./wire-schema': './src/wire-schema.ts',
		})
	})

	it('keeps non-native KOOK helpers under the managed Bot namespace', () => {
		const client = sourceFile('kook', 'api/client.ts')
		const bot = sourceFile('kook', 'bot/bot.ts')
		expect(client).not.toContain('$tool')
		expect(bot).toContain('channel: tools.createConversation')
		expect(bot).toContain('raw: this.#api.$.raw')
	})

	it.each([
		['telegram-hub-bridge', 'telegram'],
		['kook-hub-bridge', 'kook'],
	] as const)('%s owns the explicit platform-to-Hub edge', (bridge, platform) => {
		const manifest = packageJson(bridge)
		expect(manifest.dependencies).toEqual({ '@repo/chatbots-contracts': 'workspace:*' })
		expect(manifest.peerDependencies).toMatchObject({
			'@pluxel/runtime': 'workspace:*',
			'@repo/chatbots-hub': 'workspace:*',
			[`@repo/chatbots-${platform}`]: 'workspace:*',
		})
	})

	it.each(['access', 'sandbox', 'telegram', 'kook'])(
		'%s receives host-owned UI singletons as peers',
		(name) => {
			const manifest = packageJson(name)
			const peers = manifest.peerDependencies
			expect(peers).toMatchObject({
				'@mantine/core': 'catalog:',
				'@pluxel/runtime': 'workspace:*',
				'@tabler/icons-react': 'catalog:',
				react: 'catalog:',
			})
			expect(manifest.peerDependenciesMeta).toMatchObject({
				'@mantine/core': { optional: true },
				'@tabler/icons-react': { optional: true },
				react: { optional: true },
			})
		},
	)

	it.each(['hub', 'access', 'commands', 'builtins', 'sandbox', 'telegram', 'kook'])(
		'%s does not install a private runtime copy',
		(name) => {
			const manifest = packageJson(name)
			expect(manifest.dependencies ?? {}).not.toHaveProperty('@pluxel/runtime')
			expect(manifest.peerDependencies).toHaveProperty('@pluxel/runtime', 'workspace:*')
		},
	)
})
