import type { HostViteCandidate } from './attachments'

const candidate: HostViteCandidate = { commit() {}, rollback() {} }
const invalidCommit: HostViteCandidate = {
	// @ts-expect-error Publication must finish synchronously at graph acceptance.
	async commit() {},
	rollback() {},
}
const invalidRollback: HostViteCandidate = {
	commit() {},
	// @ts-expect-error Rollback must release the prepared candidate synchronously.
	async rollback() {},
}
void [candidate, invalidCommit, invalidRollback]
