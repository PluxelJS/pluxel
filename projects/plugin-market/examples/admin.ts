import { parseArgs } from 'node:util'
import { newHttpBatchRpcSession } from 'capnweb'
import type { MarketAdmin } from '../src/admin.ts'
import {
	object,
	registry as npmRegistry,
	type MarketMetadata,
	type NotificationQuery,
} from '../src/protocol.ts'
import { readSession } from '../dev/session.ts'

const { values, positionals } = parseArgs({
	options: { registry: { type: 'string' } },
	allowPositionals: true,
})
const [command, name, argument] = positionals
if (positionals.length > 3) throw new Error('Too many command arguments')
if (values.registry && ['process', 'receipt', 'retry', 'facets'].includes(command))
	throw new Error(`${command} does not take a registry filter`)
const local = process.env.MARKET_URL ? undefined : await readSession()
const marketUrl = process.env.MARKET_URL ?? local!.marketUrl
const token = process.env.MARKET_ADMIN_TOKEN ?? local?.adminToken
if (!token) throw new Error('Set MARKET_ADMIN_TOKEN when using MARKET_URL')
const registry = values.registry ?? npmRegistry

function jsonInput(raw: string | undefined, keys: readonly string[]) {
	const input: unknown = JSON.parse(raw ?? '{}')
	if (!object(input) || Object.keys(input).some((key) => !keys.includes(key)))
		throw new TypeError(`Expected a JSON object with fields: ${keys.join(', ')}`)
	return input
}

using admin = newHttpBatchRpcSession<MarketAdmin>(
	new Request(new URL('/admin', marketUrl), {
		headers: { Authorization: `Bearer ${token}` },
	}),
)
let result: unknown
switch (command) {
	case 'observe':
		if (!name || argument) throw new Error('observe <package> [--registry <base>]')
		result = await admin.observe({ registry, name })
		break
	case 'refresh':
		if (!name || !argument) throw new Error('refresh <package> <exact-version> [--registry <base>]')
		result = await admin.refresh({ registry, name, version: argument })
		break
	case 'package':
		if (!name) throw new Error('package <name> [--registry <base>]')
		result = await admin.getPackage({ registry, name })
		break
	case 'repository':
		if (!name || argument) throw new Error('repository <name> [--registry <base>]')
		result = await admin.refreshRepository({ registry, name })
		break
	case 'hide':
	case 'show':
		if (!name || !argument)
			throw new Error(`${command} <package> <expected-revision> [--registry <base>]`)
		result = await admin.setVisibility({
			registry,
			name,
			expectedRevision: Number(argument),
			hidden: command === 'hide',
		})
		break
	case 'metadata': {
		if (!name || !argument)
			throw new Error(
				'metadata <package> <JSON with expectedRevision, official, category, tags> [--registry <base>]',
			)
		const input = jsonInput(argument, [
			'expectedRevision',
			'official',
			'category',
			'tags',
		]) as MarketMetadata & { expectedRevision: number }
		result = await admin.setMetadata({ registry, name, ...input })
		break
	}
	case 'process':
		if (name) throw new Error('process takes no filters and processes one bounded batch')
		result = await admin.processNotifications()
		break
	case 'receipt':
		if (!name) throw new Error('receipt <id>')
		result = await admin.getNotification(name)
		break
	case 'notifications': {
		const input = jsonInput(name, [
			'name',
			'status',
			'code',
			'cursor',
			'limit',
		]) as NotificationQuery
		result = await admin.listNotifications({ ...input, ...(values.registry ? { registry } : {}) })
		break
	}
	case 'retry':
		if (!name) throw new Error('retry <id>')
		result = await admin.retryNotification(name)
		break
	case 'audit':
		if (!name) throw new Error('audit <package> [--registry <base>]')
		result = await admin.recentChanges({ registry, name })
		break
	case 'catalog':
	case 'facets': {
		if (command === 'facets' && (name || values.registry))
			throw new Error('facets takes no filters and returns all readable sources')
		const url = new URL(command === 'catalog' ? '/v1/packages' : '/v1/facets', marketUrl)
		if (command === 'catalog') {
			const input = jsonInput(name, ['query', 'official', 'category', 'tag', 'cursor', 'limit'])
			for (const [key, value] of Object.entries(input)) {
				const expected = key === 'limit' ? 'number' : key === 'official' ? 'boolean' : 'string'
				if (typeof value !== expected) throw new TypeError(`Invalid catalog filter: ${key}`)
				url.searchParams.set(key, String(value))
			}
			if (values.registry) url.searchParams.set('registry', registry)
		}
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(30_000),
		})
		result = await response.json()
		if (!response.ok) process.exitCode = 1
		break
	}
	default:
		throw new Error(
			'Use observe, refresh, package, repository, hide, show, metadata, process, receipt, notifications, retry, audit, catalog or facets',
		)
}
console.info(JSON.stringify(result, null, 2))
if (
	result === null ||
	(['observe', 'refresh', 'repository', 'hide', 'show', 'metadata', 'retry'].includes(command) &&
		typeof result === 'object' &&
		'status' in result &&
		['failed', 'invalid', 'conflict', 'not-found', 'not-retryable', 'unavailable'].includes(
			String(result.status),
		))
) {
	process.exitCode = 1
}
