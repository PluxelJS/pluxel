import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const dir = await mkdtemp(join(tmpdir(), 'typst-react-lifecycle-'))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const passed = []
const doc = (text) => ({
	type: 'doc',
	content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const invalid = { type: 'doc', content: [{ type: 'unknown' }] }
const body = () => page.getByRole('textbox', { name: '正文区域 body', exact: true })

async function settle() {
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	)
}
async function render(update) {
	await page.evaluate(async (next) => {
		const fixture = await import('/react-lifecycle.tsx')
		fixture.render(next)
	}, update)
	await settle()
}
async function state() {
	return page.evaluate(async () => {
		const fixture = await import('/react-lifecycle.tsx')
		return {
			instance: fixture.editor ? fixture.instances.indexOf(fixture.editor) : null,
			instances: fixture.instances.length,
			connections: fixture.connections,
			json: fixture.editor?.getJSON(),
			undo: fixture.editor?.can().undo(),
			snapshots: fixture.snapshots,
			issues: fixture.issues,
			destroyed: fixture.instances.map((instance) => instance.isDestroyed),
		}
	})
}
try {
	const origin = process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088'
	await page.goto(new URL('/react-lifecycle.html', origin).href)
	await body().waitFor({ timeout: 15000 })
	await settle()
	const initial = await state()
	assert.equal(initial.instance, 0)
	assert.equal(initial.undo, false)
	assert.equal(await body().locator('.typst-data-field').innerText(), 'Ada')
	await body().press('ControlOrMeta+End')
	await page.keyboard.insertText(' edited')
	await settle()
	const edited = await state()
	assert.equal(edited.undo, true)
	assert.notDeepEqual(edited.json, initial.json)
	assert.equal(edited.snapshots.length, 1)

	await render({ data: { name: 'Grace' } })
	assert.equal(await body().locator('.typst-data-field').innerText(), 'Grace')
	const dataOnly = await state()
	assert.equal(dataOnly.instance, initial.instance)
	assert.deepEqual(dataOnly.json, edited.json)
	assert.deepEqual(dataOnly.connections, edited.connections)
	assert.deepEqual(dataOnly.snapshots, edited.snapshots)
	await render({ content: invalid, data: { name: 'Lin' } })
	const invalidUpdate = await state()
	assert.equal(invalidUpdate.instance, initial.instance)
	assert.deepEqual(invalidUpdate.json, edited.json)
	assert.deepEqual(invalidUpdate.connections, edited.connections)
	assert.deepEqual(invalidUpdate.issues, [])
	assert.equal(await body().locator('.typst-data-field').innerText(), 'Lin')
	await page.evaluate(async () => {
		const fixture = await import('/react-lifecycle.tsx')
		fixture.editor.commands.undo()
	})
	await settle()
	const undone = await state()
	assert.deepEqual(undone.json, initial.json)
	await page.evaluate(async () => {
		const fixture = await import('/react-lifecycle.tsx')
		fixture.editor.commands.redo()
	})
	await settle()
	const redone = await state()
	assert.deepEqual(redone.json, edited.json)
	await page.screenshot({ path: join(dir, 'preserved-editor.png'), fullPage: true })
	passed.push('data and invalid later content preserve the native Editor, snapshots and undo/redo')

	await render({ documentKey: 'replacement', content: doc('Replacement') })
	await body().waitFor()
	const replacement = await state()
	assert.equal(replacement.instance, 1)
	assert.equal(replacement.undo, false)
	assert.equal(replacement.destroyed[0], true)
	assert.equal(await body().innerText(), 'Replacement')
	passed.push('a new document key mounts the replacement with fresh native history')

	await render({ editable: false, content: invalid })
	const readOnly = await state()
	assert.equal(readOnly.instance, replacement.instance)
	assert.equal(await body().getAttribute('contenteditable'), 'false')
	await page.evaluate(async () => {
		const { editor } = await import('/react-lifecycle.tsx')
		editor.commands.insertContent('forbidden')
	})
	await settle()
	const rejected = await state()
	assert.deepEqual(rejected.json, replacement.json)
	assert.deepEqual(rejected.snapshots, replacement.snapshots)
	assert.equal(rejected.issues.at(-1)[0].code, 'FORBIDDEN_REGION')
	passed.push('readonly still rejects direct native document changes after prop updates')

	await render({ documentKey: 'invalid', content: invalid, editable: true })
	const rejectedInitial = await state()
	assert.equal(rejectedInitial.instance, null)
	assert.equal(rejectedInitial.instances, replacement.instances)
	assert.equal(rejectedInitial.issues.at(-1)[0].code, 'UNKNOWN_NODE')
	assert.equal(await page.getByRole('textbox').count(), 0)
	assert.equal(await page.getByRole('alert').count(), 0)
	await render({ content: doc('Unkeyed recovery') })
	const unkeyedRecovery = await state()
	assert.equal(unkeyedRecovery.instance, null)
	assert.equal(unkeyedRecovery.issues.length, rejectedInitial.issues.length)
	await render({ documentKey: 'invalid-default', content: invalid, reportErrors: false })
	assert.match(await page.getByRole('alert').innerText(), /unknown/i)
	const defaultError = await state()
	assert.equal(defaultError.instances, replacement.instances)
	await page.screenshot({ path: join(dir, 'initial-error.png'), fullPage: true })
	passed.push(
		'invalid initialization never creates an Editor and reports through callback or default alert',
	)

	await render({
		documentKey: 'lifecycle-identities',
		content: doc('Body identity'),
		reportErrors: true,
	})
	await body().waitFor()
	const bodyIdentity = await state()
	await render({ regionId: 'notes', content: doc('Notes identity') })
	const notes = page.getByRole('textbox', { name: '正文区域 notes', exact: true })
	await notes.waitFor()
	const notesIdentity = await state()
	assert.equal(notesIdentity.instance, bodyIdentity.instance + 1)
	assert.equal(notesIdentity.destroyed[bodyIdentity.instance], true)
	assert.equal(notesIdentity.undo, false)
	assert.equal(await notes.innerText(), 'Notes identity')
	await page.evaluate(async (content) => {
		const fixture = await import('/react-lifecycle.tsx')
		fixture.replaceExtensions(content)
	}, doc('Extensions identity'))
	await settle()
	await notes.waitFor()
	const extensionsIdentity = await state()
	assert.equal(extensionsIdentity.instance, notesIdentity.instance + 1)
	assert.equal(extensionsIdentity.destroyed[notesIdentity.instance], true)
	assert.equal(extensionsIdentity.undo, false)
	assert.equal(await notes.innerText(), 'Extensions identity')
	passed.push('regionId and extension identity retain their existing reinitialization semantics')

	await page.evaluate(async () => {
		const fixture = await import('/react-lifecycle.tsx')
		fixture.unmount()
	})
	await settle()
	const unmounted = await state()
	assert.equal(unmounted.instance, null)
	assert.ok(unmounted.destroyed.every(Boolean))
	assert.equal(await page.getByRole('textbox').count(), 0)
	assert.deepEqual(pageErrors, [])
	passed.push('unmount releases every native Editor without page errors')
	await writeFile(join(dir, 'result.json'), JSON.stringify({ passed, pageErrors }, null, 2))
	console.log(JSON.stringify({ dir, passed, pageErrors }, null, 2))
} catch (error) {
	await page.screenshot({ path: join(dir, 'failure.png'), fullPage: true }).catch(() => {})
	await writeFile(
		join(dir, 'failure.json'),
		JSON.stringify({ passed, pageErrors, state: await state().catch(() => null) }, null, 2),
	)
	console.error(JSON.stringify({ dir, passed, pageErrors }, null, 2))
	throw error
} finally {
	await browser.close()
}
