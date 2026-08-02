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

type PackageKind = 'platforms' | 'plugins'

function packageJson(kind: PackageKind, name: string): PackageJson {
	return JSON.parse(readFileSync(resolve(root, kind, name, 'package.json'), 'utf8')) as PackageJson
}

function sourceDirectory(directory: string): string {
	return readdirSync(directory, { recursive: true, encoding: 'utf8' })
		.filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
		.map((file) => readFileSync(resolve(directory, file), 'utf8'))
		.join('\n')
}

function packageSource(kind: PackageKind, name: string): string {
	return sourceDirectory(resolve(root, kind, name, 'src'))
}

function platformPackageJson(name: string): PackageJson {
	return packageJson('platforms', name)
}

function platformSource(name: string): string {
	return packageSource('platforms', name)
}

function platformSourceFile(name: string, file: string): string {
	return readFileSync(resolve(root, 'platforms', name, 'src', file), 'utf8')
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

	it('inherits Pluxel runtime Vite defaults instead of patching Workbench dependencies', () => {
		const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8')
		expect(viteConfig).toContain('staticRuntimeVitePlugin')
		expect(viteConfig).not.toContain('optimizeDeps')
		expect(viteConfig).not.toContain("'@pluxel/wretch':")
		expect(viteConfig).not.toContain("'@pluxel/wretch/workbench':")
	})

	it.each(['telegram', 'kook', 'discord'])(
		'%s stays independent from ChatHub contracts',
		(name) => {
			const manifest = platformPackageJson(name)
			const declared = { ...manifest.dependencies, ...manifest.peerDependencies }
			expect(declared).not.toHaveProperty('@repo/chatbots-contracts')
			expect(declared).not.toHaveProperty('@repo/chatbots-hub')

			const contents = platformSource(name)
			expect(contents).not.toContain('@repo/chatbots-contracts')
			expect(contents).not.toContain('@repo/chatbots-hub')
		},
	)

	it.each(['telegram', 'kook'])('%s uses the host-owned Wretch capability', (name) => {
		const manifest = platformPackageJson(name)
		expect(manifest.peerDependencies).toHaveProperty('@pluxel/wretch', 'workspace:*')
		const contents = platformSource(name)
		expect(contents).toContain("from '@pluxel/wretch'")
		expect(contents).not.toContain('globalThis.fetch')
	})

	it('uses the host-owned command kernel for the KOOK typed carrier', () => {
		const manifest = platformPackageJson('kook')
		expect(manifest.dependencies).not.toHaveProperty('@pluxel/commands')
		expect(manifest.peerDependencies).toHaveProperty('@pluxel/commands', 'workspace:*')
		expect(manifest.dependencies).not.toHaveProperty('@pluxel/core')
		expect(manifest.peerDependencies).toHaveProperty('@pluxel/core', 'workspace:*')
	})

	it('uses the host-owned command kernel for the Discord slash carrier', () => {
		const manifest = platformPackageJson('discord')
		expect(manifest.dependencies).not.toHaveProperty('@pluxel/commands')
		expect(manifest.peerDependencies).toHaveProperty('@pluxel/commands', 'workspace:*')
		expect(manifest.dependencies).not.toHaveProperty('@pluxel/core')
		expect(manifest.peerDependencies).toHaveProperty('@pluxel/core', 'workspace:*')
	})

	it.each(['commands', 'builtins'])('plugins/%s uses the host-owned command kernel', (name) => {
		const manifest = packageJson('plugins', name)
		expect(manifest.dependencies ?? {}).not.toHaveProperty('@pluxel/commands')
		expect(manifest.peerDependencies).toHaveProperty('@pluxel/commands', 'workspace:*')
	})

	it.each(['telegram', 'kook'])('%s keeps its plugin entry as a thin composition root', (name) => {
		const plugin = platformSourceFile(name, 'plugin.ts')
		const manager = platformSourceFile(name, 'bot/manager.ts')
		const rootEntries = readdirSync(resolve(root, 'platforms', name, 'src'))
		const botEntries = readdirSync(resolve(root, 'platforms', name, 'src', 'bot'))
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
			const contract = platformSourceFile(name, 'workbench/contract.ts')
			const plugin = platformSourceFile(name, 'plugin.ts')
			expect(contract).toContain("id: 'bots'")
			expect(contract).toContain(`label: '${name === 'kook' ? 'KOOK' : 'Telegram'}'`)
			expect(plugin).toContain('this.ctx.workbench.mount')
		},
	)

	it('composes Telegram HTTP settings into its single Workbench extension', () => {
		const plugin = platformSourceFile('telegram', 'plugin.ts')
		const contract = platformSourceFile('telegram', 'workbench/contract.ts')
		expect(plugin.match(/this\.ctx\.workbench\.mount/g)).toHaveLength(1)
		expect(contract).toContain('WretchWorkbenchPort')
		expect(contract).toContain('httpSettings')
	})

	it('opens Bot documents as native Workbench tabs without an embedded account split', () => {
		const ui = sourceDirectory(resolve(root, 'packages/platform-kit/src'))
		expect(ui).toContain('host.openTab')
		expect(ui).not.toContain('WorkbenchSplitView')
		expect(ui).not.toContain('@worksplit/react')
		expect(ui).not.toContain('@pluxel/workbench-app')
		expect(ui).not.toContain('ChatbotsWorkbenchPlugin')
		for (const name of ['telegram', 'kook']) {
			const contract = platformSourceFile(name, 'workbench/contract.ts')
			expect(contract).toContain("route('/accounts/:accountId'")
			expect(contract).toContain('navigation: false')
		}
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
		const client = platformSourceFile('kook', 'api/client.ts')
		const bot = platformSourceFile('kook', 'bot/bot.ts')
		expect(client).not.toContain('$tool')
		expect(bot).toContain('channel: tools.createConversation')
		expect(bot).toContain('raw: this.#api.$.raw')
	})

	it.each([
		['telegram-hub-bridge', 'telegram'],
		['kook-hub-bridge', 'kook'],
	] as const)('%s owns the explicit platform-to-Hub edge', (bridge, platform) => {
		const manifest = platformPackageJson(bridge)
		expect(manifest.dependencies).toEqual({ '@repo/chatbots-contracts': 'workspace:*' })
		expect(manifest.peerDependencies).toMatchObject({
			'@pluxel/runtime': 'workspace:*',
			'@repo/chatbots-hub': 'workspace:*',
			[`@repo/chatbots-${platform}`]: 'workspace:*',
		})
	})

	it.each([
		['plugins', 'access'],
		['platforms', 'sandbox'],
		['platforms', 'telegram'],
		['platforms', 'kook'],
	] as const)('%s/%s receives host-owned UI singletons as peers', (kind, name) => {
		const manifest = packageJson(kind, name)
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
	})

	it.each([
		['plugins', 'hub'],
		['plugins', 'access'],
		['plugins', 'commands'],
		['plugins', 'builtins'],
		['platforms', 'sandbox'],
		['platforms', 'telegram'],
		['platforms', 'kook'],
	] as const)('%s/%s does not install a private runtime copy', (kind, name) => {
		const manifest = packageJson(kind, name)
		expect(manifest.dependencies ?? {}).not.toHaveProperty('@pluxel/runtime')
		expect(manifest.peerDependencies).toHaveProperty('@pluxel/runtime', 'workspace:*')
	})
})
