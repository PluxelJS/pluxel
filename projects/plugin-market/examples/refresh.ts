import { newHttpBatchRpcSession } from 'capnweb'
import type { MarketAdmin } from '../src/admin.ts'

const [name, version] = process.argv.slice(2)
if (!name || !version || !process.env.MARKET_URL || !process.env.MARKET_ADMIN_TOKEN) {
	throw new Error(
		'Set MARKET_URL and MARKET_ADMIN_TOKEN, then run: node examples/refresh.ts <package> <exact-version>',
	)
}

using admin = newHttpBatchRpcSession<MarketAdmin>(
	new Request(new URL('/admin', process.env.MARKET_URL).href, {
		headers: { Authorization: `Bearer ${process.env.MARKET_ADMIN_TOKEN}` },
	}),
)
const result = await admin.refresh({ registry: 'https://registry.npmjs.org', name, version })
console.log(JSON.stringify(result, null, 2))
if (result.status !== 'indexed') process.exitCode = 1
