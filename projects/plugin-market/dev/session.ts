import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const projectRoot = resolve(import.meta.dirname, '..')
export const repositoryRoot = resolve(projectRoot, '../..')
export const localRoot = resolve(projectRoot, '.local-market')
export const sessionPath = resolve(localRoot, 'session.json')

export type Session = {
	marketUrl: string
	publicUrl: string
	registryUrl: string
	registry: string
	registryToken: string
	notificationToken: string
	adminToken: string
}

export async function readSession(): Promise<Session> {
	try {
		const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Session
		if (!session.registry || !session.registryToken || !session.notificationToken)
			throw new Error('Restart the local market to create the current multi-registry session')
		return session
	} catch (cause) {
		throw new Error('Start the local market with: pitchfork start market', { cause })
	}
}
