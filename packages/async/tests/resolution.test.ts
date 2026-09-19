import { test } from 'vitest'
import assert from 'node:assert/strict'
import { grfn } from '@pluxel/async/grfn'
import { SKIP } from '@pluxel/async/iter'
import { grfn as sourceGraph } from '../src/grfn/index.ts'
import { SKIP as sourceSkip } from '../src/iter/index.ts'

test('@pluxel/source exports resolve to source, not a stale build', () => {
	assert.equal(grfn, sourceGraph)
	assert.equal(SKIP, sourceSkip)
})
