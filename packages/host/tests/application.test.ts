import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
	defineHostApplication,
	prepareHostApplication,
	resolveHostApplication,
	type HostApplicationFactory,
	type HostStartupContext,
} from '../src/application'
import { createHost } from '../src/host'

const startup = { root: process.cwd(), mode: 'test' as const, bindings: {}, env: { VALUE: 'one' } }

describe('shared Host application startup', () => {
	it('declares without evaluation and preserves contextual startup and concrete return types', async () => {
		let calls = 0
		const application = defineHostApplication((input) => {
			expectTypeOf(input).toEqualTypeOf<HostStartupContext>()
			calls++
			return { plugins: [], name: 'specific' as const }
		})
		expectTypeOf<ReturnType<typeof application>['name']>().toEqualTypeOf<'specific'>()
		expect(calls).toBe(0)
		await resolveHostApplication(application, startup)
		expect(calls).toBe(1)
		expect(() => {
			// @ts-expect-error An application declaration must be a factory.
			defineHostApplication({ plugins: [] })
		}).toThrow('must be a factory')
		// The helper defers evaluation, including invalid JavaScript factory results.
		// @ts-expect-error Unknown result fields are not application configuration.
		defineHostApplication(() => ({ plugins: [], typo: true }))
		// @ts-expect-error Unknown async result fields are rejected as well.
		defineHostApplication(async () => ({ plugins: [], configure() {} }))
		// @ts-expect-error The factory must return a complete application.
		defineHostApplication(async () => ({ services: [] }))
	})

	it('resolves fresh services and rolls back when application preparation fails', async () => {
		const root = await mkdtemp(fileURLToPath(new URL('./.application-', import.meta.url)))
		const entry = join(root, 'app.mjs')
		await writeFile(
			entry,
			`import {defineHostService} from '@pluxel/host';
import {defineContextCapability,installRootCapability} from '@pluxel/core/host';
export default async ({env,bindings}) => {
 const events=bindings.events; events.push('factory:'+env.VALUE); await Promise.resolve();
 return {plugins:[],services:[defineHostService({name:'ApplicationResource',capabilities:[installRootCapability(defineContextCapability('ApplicationResource'),{create:()=>env.VALUE})],prepare({effects}){events.push('prepare:'+env.VALUE);effects.defer(()=>events.push('close:'+env.VALUE))}})],prepare({startup}){if(startup.env.VALUE==='fail')throw new Error('application prerequisite failed')}};
}`,
		)
		try {
			const result = await promisify(execFile)(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`import assert from 'node:assert/strict'; const {runHostApplication}=await import(${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)}); const events=[];const startup={root:${JSON.stringify(root)},mode:'test',env:{VALUE:'one'},bindings:{events}};const host=await runHostApplication(${JSON.stringify(entry)},{startup});await host.close();await assert.rejects(runHostApplication(${JSON.stringify(entry)},{startup:{...startup,env:{VALUE:'fail'}}}),/application prerequisite failed/);console.log(JSON.stringify(events))`,
				],
				{ timeout: 10000 },
			)
			expect(JSON.parse(result.stdout)).toEqual([
				'factory:one',
				'prepare:one',
				'close:one',
				'factory:fail',
				'prepare:fail',
				'close:fail',
			])
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('isolates concurrent startup inputs and shares each frozen snapshot with prepare', async () => {
		const handle = { count: 0 }
		const input = {
			...startup,
			env: { VALUE: 'first' },
			bindings: { handle },
			deployment: { root: '/first', target: 'node' as const, variant: 'headless' as const },
		}
		const seen: HostStartupContext[] = []
		let release!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		const application = defineHostApplication(async (snapshot) => {
			seen.push(snapshot)
			await barrier
			return {
				plugins: [],
				name: snapshot.env.VALUE,
				prepare({ startup: preparedStartup }) {
					expect(preparedStartup).toBe(snapshot)
				},
			}
		})
		const first = resolveHostApplication(application, input)
		input.env.VALUE = 'second'
		input.deployment.root = '/second'
		const second = resolveHostApplication(application, input)
		release()
		const [a, b] = await Promise.all([first, second])
		expect([a.name, b.name]).toEqual(['first', 'second'])
		expect(a.startup.deployment?.root).toBe('/first')
		expect(a.startup).not.toBe(b.startup)
		expect(a.startup.env).not.toBe(b.startup.env)
		expect(a.startup.bindings).not.toBe(b.startup.bindings)
		for (const snapshot of seen) {
			expect(Object.isFrozen(snapshot)).toBe(true)
			expect(Object.isFrozen(snapshot.env)).toBe(true)
			expect(Object.isFrozen(snapshot.bindings)).toBe(true)
			expect(snapshot.bindings.handle).toBe(handle)
		}
		expect(Object.isFrozen(handle)).toBe(false)
		expect(Object.isFrozen(input.env)).toBe(false)
		const host = await createHost({ plugins: [] })
		try {
			await prepareHostApplication(a, host)
			await prepareHostApplication(b, host)
		} finally {
			await host.close()
		}
	})

	it('propagates factory rejection before service preparation', async () => {
		const failure = new Error('factory failure')
		await expect(
			resolveHostApplication(
				defineHostApplication(async () => {
					throw failure
				}),
				startup,
			),
		).rejects.toBe(failure)
	})

	it.each([
		[{ plugins: [] }, 'must be a factory'],
		[(): undefined => undefined, 'must be an object'],
		[() => ({ plugins: [] as const, configure() {} }), 'unsupported "configure"'],
		[() => ({ plugins: [] as const, services: {} }), 'services must be an array'],
	])('rejects invalid JavaScript declarations at the boundary', async (application, message) => {
		await expect(
			resolveHostApplication(application as unknown as HostApplicationFactory, startup),
		).rejects.toThrow(message as string)
	})
})
