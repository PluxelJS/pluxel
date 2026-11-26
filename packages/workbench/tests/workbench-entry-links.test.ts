import { defineServiceRef, parsePluginNodeAddress } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import {
	workbench,
	type Workbench,
	type WorkbenchEntryLink,
	type WorkbenchPublication,
} from '@pluxel/workbench'
import { readWorkbenchEntryLink, readWorkbenchShortcuts } from '@pluxel/workbench/client'
import { WorkbenchHost } from '@pluxel/workbench/server'
import { RpcTarget } from 'capnweb'
import { describe, expect, it } from 'vitest'

const WorkbenchRef = defineServiceRef<Workbench>()
const renderer = './editor.tsx'
const EditorWorkbench = workbench.define(import.meta.url, {
	editor: workbench.view<RpcTarget>({
		renderer,
		placement: { kind: 'route', path: '/bots/:bot/documents/:doc', title: 'Edit' },
	}),
	list: workbench.view<RpcTarget>({
		renderer,
		placement: { kind: 'route', path: '/documents', title: 'Documents' },
	}),
	latest: workbench.view<RpcTarget>({
		renderer,
		placement: { kind: 'route', path: '/bots/site/documents/latest', title: 'Latest' },
	}),
	settings: workbench.view<RpcTarget>({ renderer, placement: { kind: 'tab' } }),
	tools: workbench.view<RpcTarget>({
		renderer,
		placement: { kind: 'panel', label: 'Tools', region: 'right' },
	}),
	attachment: workbench.attachment<RpcTarget>({ renderer }),
})

const bindings = {
	editor: () => new RpcTarget(),
	list: () => new RpcTarget(),
	latest: () => new RpcTarget(),
	settings: () => new RpcTarget(),
	tools: () => new RpcTarget(),
	attachment: () => new RpcTarget(),
}

@Plugin({ forkable: true })
class EditorPlugin extends BasePlugin {
	publication?: WorkbenchPublication<typeof EditorWorkbench>
	initialLink?: WorkbenchEntryLink

	protected override init() {
		const publication = this.ctx.service(WorkbenchRef)?.publish(EditorWorkbench, bindings)
		this.publication = publication
		this.initialLink = publication?.link('list')
	}
}

describe('Workbench publication links', () => {
	it('identifies the publishing fork and round-trips concrete params through the current session', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(EditorPlugin)
		const fork = host.fork(EditorPlugin, 'east')
		host.start(EditorPlugin)
		host.start(fork)
		await host.commit()

		const east = host.require(fork)
		expect(east.initialLink).toEqual({ target: fork, entryKey: 'list' })
		expect(host.require(EditorPlugin).initialLink?.target).toEqual(
			parsePluginNodeAddress(EditorPlugin.nodeAddress()),
		)
		const publication = east.publication!
		expect(publication.link('settings')).toEqual({ target: fork, entryKey: 'settings' })
		const params = { bot: 'west %?#字', doc: ':doc' }
		const link = readWorkbenchEntryLink(
			JSON.parse(JSON.stringify(publication.link('editor', params))),
		)
		expect(link).toEqual({
			target: fork,
			entryKey: 'editor',
			location: '/bots/west%20%25%3F%23%E5%AD%97/documents/%3Adoc',
		})
		const session = host.ctx
			.service(WorkbenchHost)
			.createSession({ provider: 'local', subject: 'editor' }, () => {})
		try {
			const layout = session.target.layoutDto({ target: link.target })
			const entry = layout.entries.find(({ descriptor }) => descriptor.key === link.entryKey)!
			const result = await session.target.openEntry({
				target: link.target,
				descriptor: entry.descriptor,
				layoutRevision: layout.revision,
				location: link.location,
			})
			expect(result).toMatchObject({ ok: true, value: { kind: 'local', params } })
			const staticLocation = '/bots/site/documents/latest'
			for (const location of [
				staticLocation,
				'/bots/:bot/documents/:doc',
				'/bots/site/documents/%E0%A4',
				'/bots/site/documents/a%2Fb',
				'/bots/site/documents/' + 'x'.repeat(513),
			]) {
				await expect(
					session.target.openEntry({
						target: link.target,
						descriptor: entry.descriptor,
						layoutRevision: layout.revision,
						location,
					}),
				).resolves.toEqual({ ok: false, code: 'target_unavailable' })
			}
			await expect(
				session.target.openEntry({
					target: link.target,
					descriptor: layout.entries.find(({ descriptor }) => descriptor.key === 'latest')!
						.descriptor,
					layoutRevision: layout.revision,
					location: staticLocation,
				}),
			).resolves.toMatchObject({ ok: true, value: { params: {} } })
		} finally {
			session.dispose()
		}
		expect(() =>
			readWorkbenchShortcuts([link, publication.link('editor', { ...params, doc: 'other' })]),
		).toThrow('duplicate')
	})

	it('rejects unplaced attachments, panels, unknown entries, and invalid route parameters', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(EditorPlugin).start(EditorPlugin)
		await host.commit()
		const publication = host.require(EditorPlugin).publication!
		expect(() => publication.link('tools')).toThrow('panel')
		for (const key of ['attachment', 'unknown']) {
			expect(() => Reflect.apply(publication.link, publication, [key])).toThrow(key)
		}
		expect(() => publication.link('settings', { id: 'unexpected' })).toThrow('tab')
		expect(() => publication.link('list', { id: 'unexpected' })).toThrow('unexpected')
		expect(() => publication.link('editor')).toThrow('bot')
		expect(() => publication.link('editor', { bot: 'east' })).toThrow('doc')
		expect(() => publication.link('editor', { bot: 'east', doc: 'x', extra: 'y' })).toThrow('extra')
		expect(() => publication.link('editor', { bot: 'site', doc: 'latest' })).toThrow(
			/static route.*latest/,
		)
		for (const doc of [
			'',
			'.',
			'..',
			'a/b',
			'a\\b',
			'z'.repeat(513),
			String.fromCharCode(0xd800),
			null,
			3,
		]) {
			expect(() =>
				Reflect.apply(publication.link, publication, ['editor', { bot: 'east', doc }]),
			).toThrow('doc')
		}
		expect(() => publication.link('editor', { bot: '字'.repeat(512), doc: 'a' })).toThrow(
			'location',
		)
	})

	it('allows only one publication per generation and revokes a retained handle after restart', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(EditorPlugin).start(EditorPlugin)
		await host.commit()
		const owner = host.require(EditorPlugin)
		const first = owner.publication!
		expect(() => owner.ctx.service(WorkbenchRef)!.publish(EditorWorkbench, bindings)).toThrow(
			'only once',
		)
		const link = first.link('settings')
		host.stop(EditorPlugin)
		await host.commit()
		expect(() => first.link('settings')).toThrow('owner stopped')
		host.start(EditorPlugin)
		await host.commit()
		expect(() => first.link('settings')).toThrow('owner stopped')
		expect(host.require(EditorPlugin).publication!.link('settings')).toEqual(link)
	})
})
