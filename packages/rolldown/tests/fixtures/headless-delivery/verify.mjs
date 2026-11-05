import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [delivery, application, dataRoot] = process.argv.slice(2)
assert.ok(['standalone', 'modules'].includes(delivery))

function pdfDocument() {
	// A large, valid content stream makes disconnects observable before the file finishes.
	const content =
		'BT /F1 12 Tf 10 10 Td (Native libSQL delivery) Tj ET\n' + '% padding\n'.repeat(2_000_000)
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
	]
	let text = '%PDF-1.4\n'
	const offsets = [0]
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(text))
		text += `${index + 1} 0 obj\n${object}\nendobj\n`
	}
	const xref = Buffer.byteLength(text)
	text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
	text += offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
		.join('')
	text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return Buffer.from(text)
}

async function start(directory, failQuery = false) {
	await mkdir(directory, { recursive: true })
	const child = spawn(
		process.execPath,
		['--import', join(import.meta.dirname, 'guard.mjs'), join(application, 'start.mjs'), delivery],
		{
			cwd: application,
			env: { ...process.env, DATA_DIRECTORY: directory, FAIL_QUERY: failQuery ? '1' : '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 30_000,
			killSignal: 'SIGKILL',
		},
	)
	let stderr = ''
	child.stderr.setEncoding('utf8').on('data', (text) => {
		stderr += text
	})
	const lines = []
	const output = createInterface({ input: child.stdout })
	output.on('line', (line) => lines.push(line))
	const exited = once(child, 'exit')
	const waitFor = async (predicate) => {
		const signal = AbortSignal.timeout(15_000)
		while (true) {
			const found = lines.find(predicate)
			if (found !== undefined) return found
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(
					`Application exited before the expected output:\n${lines.join('\n')}\n${stderr}`,
				)
			await Promise.race([
				once(output, 'line', { signal }),
				exited.then(() => {
					throw new Error(`Application exited:\n${lines.join('\n')}\n${stderr}`)
				}),
			])
		}
	}
	return { child, lines, exited, waitFor, stderr: () => stderr }
}

const successDirectory = join(dataRoot, 'success')
await mkdir(successDirectory, { recursive: true })
const pdf = pdfDocument()
await writeFile(join(successDirectory, 'example.pdf'), pdf)
const success = await start(successDirectory)
try {
	const listening = await success.waitFor((line) => line.startsWith('LISTENING '))
	const origin = `http://127.0.0.1:${Number(listening.slice('LISTENING '.length))}`
	assert.deepEqual(await (await fetch(`${origin}/query`)).json(), { answer: 42 })
	const missing = await fetch(`${origin}/documents/missing`, { headers: { accept: 'text/html' } })
	assert.equal(missing.status, 404)
	assert.equal(missing.headers.get('x-document'), 'missing')
	assert.equal(await missing.text(), 'document missing')
	const page = await fetch(`${origin}/nested/page`, { headers: { accept: 'text/html' } })
	assert.equal(page.status, 200)
	assert.match(await page.text(), /Headless document application/)
	const reserved = await fetch(`${origin}/@vite/client`, { headers: { accept: 'text/html' } })
	assert.equal(reserved.status, 404)
	await reserved.arrayBuffer()
	const complete = await fetch(`${origin}/documents/example.pdf`)
	assert.equal(complete.headers.get('content-type'), 'application/pdf')
	assert.deepEqual(Buffer.from(await complete.arrayBuffer()), pdf)

	const canceled = await fetch(`${origin}/documents/example.pdf`)
	const canceledReader = canceled.body.getReader()
	assert.equal((await canceledReader.read()).done, false)
	await canceledReader.cancel()
	await success.waitFor((line) => line === 'EVENT pdf.aborted')

	const stopping = await fetch(`${origin}/documents/example.pdf`)
	const stoppingReader = stopping.body.getReader()
	assert.equal((await stoppingReader.read()).done, false)
	success.child.kill('SIGTERM')
	assert.deepEqual(await success.exited, [0, null], success.stderr())
	await stoppingReader.cancel().catch(() => {})
	const events = (await readFile(join(successDirectory, 'events.log'), 'utf8')).trim().split('\n')
	assert.equal(events.filter((event) => event === 'database.prepared').length, 1)
	assert.equal(events.filter((event) => event === 'database.closed').length, 1)
	assert.equal(events.filter((event) => event === 'pdf.completed').length, 1)
	assert.equal(events.filter((event) => event === 'pdf.aborted').length, 2)
	assert.equal(events.at(-1), 'database.closed')
} finally {
	if (success.child.exitCode === null && success.child.signalCode === null) {
		success.child.kill('SIGKILL')
		await success.exited
	}
}

const failureDirectory = join(dataRoot, 'failure')
const failure = await start(failureDirectory, true)
try {
	assert.deepEqual(await failure.exited, [1, null], failure.stderr())
	assert.equal(
		failure.lines.some((line) => line.startsWith('LISTENING ')),
		false,
	)
	assert.match(failure.stderr(), /STARTUP_ERROR startup_rejected/)
	const events = (await readFile(join(failureDirectory, 'events.log'), 'utf8')).trim().split('\n')
	assert.deepEqual(events, ['database.prepared', 'database.closed'])
} finally {
	if (failure.child.exitCode === null && failure.child.signalCode === null) {
		failure.child.kill('SIGKILL')
		await failure.exited
	}
}
console.log(
	`HEADLESS_DELIVERY_OK ${delivery} ${process.version} ${process.platform}/${process.arch}`,
)
