import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalFonts } from '@napi-rs/canvas'
import { createMemoryPersistenceBackend } from '@pluxel/runtime'
import {
	assertPluginLifecycleIssue,
	BasePlugin,
	Plugin,
	withRuntimeHost,
} from '@pluxel/runtime/test'
import { workbench, type WorkbenchLayout } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE,
} from '@pluxel/runtime/web/paths'
import { describe, expect, it } from 'vitest'
import { FontsError, FontsPlugin, type FontRegistration } from '../src/index.ts'
import type { FontsWorkbenchCommands } from '../src/manager-contract.ts'
import { FontsSelectionPort } from '../src/workbench-contract.ts'

const ConsumerWorkbench = workbench.portOutlet({
	id: 'Fonts',
	port: FontsSelectionPort,
	placement: workbenchContract.tab({
		label: 'Fonts',
		icon: workbenchContract.icons.Typography,
	}),
})

@Plugin({ name: 'FontsTestConsumer' })
class FontsTestConsumer extends BasePlugin {
	constructor(readonly fonts: FontsPlugin) {
		super()
	}

	override init(): void {
		this.ctx.workbench.mount(ConsumerWorkbench, {
			selection: workbench.bind.rpc(() => this.fonts.selectionManager()),
		})
	}
}

@Plugin({ name: 'FontsLazyConsumer' })
class FontsLazyConsumer extends BasePlugin {
	constructor(readonly fonts: FontsPlugin) {
		super()
	}
}

const fontPath = findTestFont()
const discoveredFamily = GlobalFonts.families[0]?.family

describe('FontsPlugin', () => {
	it('classifies fonts discovered from the host system and resolves an automatic default', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([FontsPlugin, FontsLazyConsumer])
				host.cfg(FontsPlugin).enable()
				await host.commit()
				const fonts = host.require(FontsLazyConsumer).fonts

				expect(fonts.families.every(({ source }) => source === 'system')).toBe(true)
				expect(fonts.defaultFont.cssFamily).toBeTruthy()
				expect(['system', 'generic']).toContain(fonts.defaultFont.source)
				expect(
					fonts.defaultFont.source !== 'system' ||
						fonts.families.some(({ family }) => family === fonts.defaultFont.family),
				).toBe(true)
				expect(host.isRunning(FontsPlugin)).toBe(true)
				expect(host.ctx.workbench.enabled).toBe(false)
			},
			{ workbench: false },
		)
	})

	it.skipIf(!discoveredFamily)(
		'persists a Workbench default and resets to the host-configured family',
		async () => {
			const backend = createMemoryPersistenceBackend()
			await withRuntimeHost(
				async (host) => {
					host.add([FontsPlugin, FontsTestConsumer])
					host.cfg(FontsPlugin).set({ config: { defaultFamily: 'serif' } })
					host.cfg(FontsPlugin).enable()
					await host.commit()

					let commands = host.require(FontsTestConsumer).fonts.selectionManager()
					const selected = await commands.setDefaultFamily(discoveredFamily!)
					expect(selected.defaultFont).toMatchObject({
						family: discoveredFamily,
						workbenchFamily: discoveredFamily,
						configuredFamily: 'serif',
						source: 'workbench',
					})

					host.restart(FontsPlugin, { cascadeDependents: true })
					await host.commit()
					commands = host.require(FontsTestConsumer).fonts.selectionManager()
					const restored = await commands.snapshot()
					expect(restored.defaultFont).toMatchObject({
						family: discoveredFamily,
						workbenchFamily: discoveredFamily,
						source: 'workbench',
					})

					const reset = await commands.setDefaultFamily(null)
					expect(reset.defaultFont).toMatchObject({
						family: 'serif',
						configuredFamily: 'serif',
						source: 'config',
					})
					expect(reset.defaultFont.workbenchFamily).toBeUndefined()
					await expect(commands.setDefaultFamily('Definitely Missing Font')).rejects.toMatchObject({
						code: 'FONT_NOT_FOUND',
					})
				},
				{ workbench: false, persistence: { mode: 'custom', backend } },
			)
		},
	)

	it.skipIf(!fontPath)('owns native font registrations with the caller lifecycle', async () => {
		const family = `Pluxel Lifecycle ${crypto.randomUUID()}`
		let registration: FontRegistration | undefined
		await withRuntimeHost(
			async (host) => {
				host.add([FontsPlugin, FontsLazyConsumer])
				host.cfg(FontsPlugin).enable()
				await host.commit()

				registration = host.require(FontsLazyConsumer).fonts.registerFromPath({
					path: fontPath!,
					family,
				})
				expect(registration.active).toBe(true)
				expect(registration.families).toContain(family)
				expect(GlobalFonts.has(family)).toBe(true)
				expect(
					host.require(FontsLazyConsumer).fonts.families.find((item) => item.family === family),
				).toMatchObject({ source: 'registered' })

				host.remove(FontsLazyConsumer)
				await host.commit()
				expect(registration.active).toBe(false)
				expect(GlobalFonts.has(family)).toBe(false)
				registration.dispose()
			},
			{ workbench: false },
		)
	})

	it.skipIf(!fontPath)(
		'keeps one provider-owned managed collection across consumer lifecycles and reloads',
		async () => {
			const backend = createMemoryPersistenceBackend()
			const family = `Pluxel Managed ${crypto.randomUUID()}`
			const data = await readFile(fontPath!)

			await withRuntimeHost(
				async (host) => {
					host.add([FontsPlugin, FontsTestConsumer])
					host.cfg(FontsPlugin).enable()
					await host.commit()

					const commands = managerForTest(host.require(FontsPlugin))
					const [first, duplicate] = await Promise.all([
						commands.install({ fileName: 'brand.ttf', family, data }),
						commands.install({ fileName: 'brand-copy.ttf', family, data }),
					])
					expect(first.managedFonts).toHaveLength(1)
					expect(duplicate.managedFonts).toHaveLength(1)
					expect(GlobalFonts.has(family)).toBe(true)
					const id = first.managedFonts[0]!.id

					host.remove(FontsTestConsumer)
					await host.commit()
					expect(GlobalFonts.has(family)).toBe(true)

					host.add(FontsTestConsumer)
					await host.commit()
					const restored = await managerForTest(host.require(FontsPlugin)).snapshot()
					expect(restored.managedFonts).toEqual([
						expect.objectContaining({ id, fileName: 'brand.ttf', family }),
					])
					expect(GlobalFonts.has(family)).toBe(true)

					host.restart(FontsPlugin, { cascadeDependents: true })
					await host.commit()
					const reloaded = await managerForTest(host.require(FontsPlugin)).snapshot()
					expect(reloaded.managedFonts).toEqual([
						expect.objectContaining({ id, fileName: 'brand.ttf', family }),
					])
					expect(GlobalFonts.has(family)).toBe(true)

					const removed = await managerForTest(host.require(FontsPlugin)).remove(id)
					expect(removed.managedFonts).toEqual([])
					expect(GlobalFonts.has(family)).toBe(false)
				},
				{ workbench: false, persistence: { mode: 'custom', backend } },
			)
		},
	)

	it('rejects invalid bytes and enforces the configured byte budget', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([FontsPlugin, FontsLazyConsumer])
				host.cfg(FontsPlugin).set({ config: { maxFontBytes: 4 } })
				host.cfg(FontsPlugin).enable()
				await host.commit()
				const fonts = host.require(FontsLazyConsumer).fonts

				expect(() => fonts.register({ data: new Uint8Array([1, 2, 3]) })).toThrow(
					expect.objectContaining<Partial<FontsError>>({ code: 'INVALID_FONT' }),
				)
				expect(() => fonts.register({ data: new Uint8Array(5) })).toThrow(
					expect.objectContaining<Partial<FontsError>>({ code: 'FONT_TOO_LARGE' }),
				)
			},
			{ workbench: false },
		)
	})

	it('fails the provider instead of silently skipping corrupt persisted state', async () => {
		const fontBackend = createMemoryPersistenceBackend()
		await fontBackend
			.namespace('@pluxel/fonts')
			.put(`managed/${'a'.repeat(43)}.font`, new Uint8Array([1, 2, 3]))
		const selectionBackend = createMemoryPersistenceBackend()
		await selectionBackend.namespace('@pluxel/fonts').put('settings/default-font.json', '{broken')

		for (const [backend, message] of [
			[fontBackend, 'Managed font is corrupt'],
			[selectionBackend, 'Default font preference is corrupt'],
		] as const) {
			await withRuntimeHost(
				async (host) => {
					host.add([FontsPlugin, FontsLazyConsumer])
					host.cfg(FontsPlugin).enable()
					const summary = await host.commitAllowFail()
					assertPluginLifecycleIssue(summary, FontsPlugin, { kind: 'start-failed', message })
					expect(host.isRunning(FontsPlugin)).toBe(false)
					expect(host.isRunning(FontsLazyConsumer)).toBe(false)
				},
				{ workbench: false, persistence: { mode: 'custom', backend } },
			)
		}
	})

	it('renders direct consumer and provider-owned Workbench views', async () => {
		await withRuntimeHost(async (host) => {
			host.add([FontsPlugin, FontsTestConsumer])
			host.cfg(FontsPlugin).enable()
			await host.commit()

			const response = await host.ctx.http.fetch(
				new Request(
					`http://local.test${RUNTIME_INTERNAL_API_BASE}${RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE}/FontsTestConsumer`,
				),
			)
			expect(response.status).toBe(200)
			const layout = (await response.json()) as WorkbenchLayout
			expect(layout.items).toEqual([
				expect.objectContaining({
					ownerPluginId: 'FontsPlugin',
					targetPluginId: 'FontsTestConsumer',
					viewId: 'FontSelection',
					port: expect.objectContaining({
						id: '@pluxel/fonts.selection',
						model: { selection: expect.objectContaining({ kind: 'rpc' }) },
					}),
				}),
			])

			const providerResponse = await host.ctx.http.fetch(
				new Request(
					`http://local.test${RUNTIME_INTERNAL_API_BASE}${RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE}/FontsPlugin`,
				),
			)
			expect(providerResponse.status).toBe(200)
			const providerLayout = (await providerResponse.json()) as WorkbenchLayout
			expect(providerLayout.items).toEqual([
				expect.objectContaining({
					ownerPluginId: 'FontsPlugin',
					targetPluginId: 'FontsPlugin',
					viewId: 'Fonts',
					model: { fonts: expect.objectContaining({ kind: 'rpc' }) },
				}),
			])
		})
	})
})

function findTestFont(): string | undefined {
	const candidates = [
		'/usr/share/fonts/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
		'/System/Library/Fonts/Supplemental/Arial.ttf',
		process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'arial.ttf') : '',
	]
	return candidates.find((candidate) => candidate && existsSync(candidate))
}

function managerForTest(fonts: FontsPlugin): FontsWorkbenchCommands {
	return (
		fonts as unknown as {
			createWorkbenchManager(): FontsWorkbenchCommands
		}
	).createWorkbenchManager()
}
