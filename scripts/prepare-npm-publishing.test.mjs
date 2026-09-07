import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
	matchesPublisher,
	parseTrustOutput,
	preparePublishing,
	validatePublishLock,
} from './prepare-npm-publishing.mts'

const publisher = {
	type: 'github',
	repository: 'PluxelJS/pluxel',
	file: 'release.yml',
	permissions: ['createPackage'],
}
const names = ['@pluxel/first', '@pluxel/second']
const lock = { 'npm:packages': names.map((name) => ({ id: `npm:${name}` })) }

function harness(options = {}) {
	const calls = []
	const configured = new Set(options.configured)
	const dependencies = {
		log() {},
		async wait() {},
		run(command, args) {
			calls.push([command, ...args])
			if (args[0] === '--version') return options.version ?? '11.16.0\n'
			if (args[0] === 'whoami' && options.loginError) throw new Error('login required')
			if (command === 'pnpm' && options.pretrustError) throw new Error('pretrust failed')
			if (args[0] === 'trust' && args[1] === 'list') {
				if (options.listError) throw new Error('registry failed')
				if (options.malformed) return 'not JSON'
				return configured.has(args[2]) ? JSON.stringify(publisher) : ''
			}
			if (args[0] === 'trust' && args[1] === 'github' && !options.unconfirmed)
				configured.add(args[2])
			return ''
		},
	}
	return { calls, configured, dependencies }
}

describe('npm publishing preparation', () => {
	it('reads npm object streams including nested objects and braces in escaped strings', () => {
		const first = { ...publisher, nested: { value: 'a } " { \\ b' } }
		assert.deepEqual(
			parseTrustOutput(`\n${JSON.stringify(first, null, 2)}\n\n${JSON.stringify(publisher)}\n`),
			[first, publisher],
		)
		assert.deepEqual(parseTrustOutput(' \n'), [])
		for (const invalid of ['[]', '{} garbage', '{"a":', '{broken}', '{"a":true,}']) {
			assert.throws(() => parseTrustOutput(invalid))
		}
	})
	it('requires the intended workflow, repository and direct publish permission', () => {
		assert.equal(matchesPublisher(publisher), true)
		for (const change of [
			{ repository: 'other/pluxel' },
			{ file: 'other.yml' },
			{ environment: 'production' },
			{ permissions: ['createStagedPackage'] },
			{ permissions: undefined },
			{ type: 'gitlab' },
		])
			assert.equal(matchesPublisher({ ...publisher, ...change }), false)
	})
	it('requires a complete lock before even invoking npm', async () => {
		for (const badLock of [
			undefined,
			{},
			{ 'npm:packages': [] },
			{ 'npm:packages': [lock['npm:packages'][0], lock['npm:packages'][0]] },
		]) {
			assert.throws(() => validatePublishLock(badLock, names))
		}
		const { calls, dependencies } = harness()
		await assert.rejects(preparePublishing(true, names, {}, dependencies))
		assert.deepEqual(calls, [])
	})
	it('defaults to a Tegami dry run without account or trust writes', async () => {
		const { calls, dependencies } = harness()
		await preparePublishing(false, names, lock, dependencies)
		assert.deepEqual(calls, [
			['npm', '--version'],
			['pnpm', 'tegami', 'npm', 'pretrust', '--dry-run'],
		])
	})
	it('checks toolchain and login before any publication', async () => {
		for (const options of [{ version: '11.14.0' }, { version: '10.99.0' }, { loginError: true }]) {
			const { calls, dependencies } = harness(options)
			await assert.rejects(preparePublishing(true, names, lock, dependencies))
			assert.equal(
				calls.some(([command]) => command === 'pnpm'),
				false,
			)
		}
	})
	it('preserves existing matching publishers and verifies newly configured packages', async () => {
		const { calls, dependencies } = harness({ configured: [names[0]] })
		await preparePublishing(true, names, lock, dependencies)
		assert.deepEqual(
			calls.filter(([, sub, provider]) => sub === 'trust' && provider === 'github'),
			[
				[
					'npm',
					'trust',
					'github',
					names[1],
					'--repo',
					'PluxelJS/pluxel',
					'--file',
					'release.yml',
					'--allow-publish',
					'--yes',
				],
			],
		)
		assert.equal(
			calls.filter(
				([, sub, action, name]) => sub === 'trust' && action === 'list' && name === names[1],
			).length,
			2,
		)
	})
	it('does not treat authentication, malformed responses or unconfirmed writes as success', async () => {
		for (const options of [{ listError: true }, { malformed: true }, { unconfirmed: true }]) {
			const { dependencies } = harness(options)
			await assert.rejects(preparePublishing(true, names, lock, dependencies))
		}
	})
	it('reports partial pretrust failure and repairs leftover missing trust on the next run', async () => {
		const options = { pretrustError: true, configured: [names[1]] }
		const { dependencies, calls, configured } = harness(options)
		await assert.rejects(preparePublishing(true, names, lock, dependencies), /pretrust failed/)
		assert.equal(
			calls.some(([, sub]) => sub === 'trust'),
			false,
		)
		options.pretrustError = false
		await preparePublishing(true, names, lock, dependencies)
		assert.deepEqual([...configured].sort(), names)
		calls.length = 0
		await preparePublishing(true, names, lock, dependencies)
		assert.equal(
			calls.some(([, sub, action]) => sub === 'trust' && action === 'github'),
			false,
		)
	})
})
