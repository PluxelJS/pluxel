import { createDiskFixture, createFixture, type TestFixture } from '@pluxel/test/fixtures'

function fileOperations(fixture: TestFixture) {
	const path = fixture.getPath('value.txt')
	fixture.fs.readFile(path, (_error, value) => void value)
	fixture.fs.readFile(path, 'utf8', (_error, value) => void value)
	fixture.fs.writeFile(path, 'value', (_error) => {})
	fixture.fs.writeFile(path, 'value', 'utf8', (_error) => {})
	const write: Promise<void> = fixture.fsp.writeFile(path, 'value')
	const read: Promise<string | Buffer> = fixture.fsp.readFile(path, 'utf8')
	// @ts-expect-error Callback fs is not the upstream Promise fs API.
	fixture.fs.readFile(path, 'utf8')
	// @ts-expect-error Writes must have a callback; Promise operations use fsp.
	fixture.fs.writeFile(path, 'value')
	// @ts-expect-error Explicit options do not make the callback optional.
	fixture.fs.writeFile(path, 'value', 'utf8')
	return { write, read }
}

function options() {
	// @ts-expect-error Memory fixtures own their temporary directory.
	createFixture({}, { tempDir: '/tmp/custom' })
	// @ts-expect-error Memory fixtures own their filesystem.
	createFixture({}, { fs: {} })
	// @ts-expect-error Disk fixtures always use native fs.
	createDiskFixture({}, { fs: {} })
	createDiskFixture({}, { tempDir: '/tmp/custom' })
}
void fileOperations
void options
