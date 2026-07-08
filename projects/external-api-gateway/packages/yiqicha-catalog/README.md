# @repo/external-api-gateway-yiqicha-catalog

YiQiCha open platform client generated from the public web API catalog.

The scraped catalog is stored in `data/apis.json` and currently contains 132 APIs with the web page demos: Java, Python, PHP, Node.js, and C#.

```ts
import {
	YiqichaClient,
	getApiExamples,
	yiqichaApiCodes,
	type GetInvestEnterpriseResponse,
} from '@repo/external-api-gateway-yiqicha-catalog'

const client = new YiqichaClient({
	appkey: process.env.YIQICHA_APPKEY!,
	secretKey: process.env.YIQICHA_SECRET_KEY!,
})

const result = await client.apis.getInvestEnterprise({
	keyword: '新疆绿翔农资有限公司',
})
const typed: GetInvestEnterpriseResponse = result

console.log(typed.data.list[0]?.childEntName)
console.log(getApiExamples('1004').node)
console.log(yiqichaApiCodes.getInvestEnterprise) // "1004"
```

You can call APIs by generated key, API code, API id, or Chinese API name:

```ts
await client.call('getInvestEnterprise', { keyword: '新疆绿翔农资有限公司' })
await client.call('1004', { keyword: '新疆绿翔农资有限公司' })
await client.call('对外投资', { keyword: '新疆绿翔农资有限公司' })
```

Regenerate the local catalog with:

```sh
pnpm --filter @repo/external-api-gateway-yiqicha-catalog scrape
```

Regenerate only the TypeScript API keys and request/response types from the local catalog:

```sh
pnpm --filter @repo/external-api-gateway-yiqicha-catalog generate-types
```
