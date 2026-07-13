import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

type PackageJson = {
	dependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function packageJson(name: string): PackageJson {
	return JSON.parse(
		readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8'),
	) as PackageJson
}

function packageSource(name: string): string {
	const directory = resolve(root, 'packages', name, 'src')
	return readdirSync(directory, { recursive: true, encoding: 'utf8' })
		.filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
		.map((file) => readFileSync(resolve(directory, file), 'utf8'))
		.join('\n')
}

describe('chatbots package boundaries', () => {
	it('keeps host-owned UI and bridge assembly at the project root', () => {
		const host = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageJson
		expect(host.dependencies).toMatchObject({
			'@mantine/core': '^9.4.1',
			'@repo/chatbots-kook-hub': 'workspace:*',
			'@repo/chatbots-telegram-hub': 'workspace:*',
			'@tabler/icons-react': '^3.37.1',
			react: '^19.2.7',
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

	it.each([
		['telegram-hub', 'telegram'],
		['kook-hub', 'kook'],
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
				'@mantine/core': '^9.4.1',
				'@pluxel/runtime': 'workspace:*',
				'@tabler/icons-react': '^3.37.1',
				react: '^19.2.7',
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
