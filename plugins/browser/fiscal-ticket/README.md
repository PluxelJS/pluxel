# @pluxel/fiscal-ticket

Experimental browser-assisted queries of the [national fiscal electronic ticket portal](https://pjcy.mof.gov.cn/html/index.html#/home). This is fiscal-ticket support, not tax-invoice verification. It uses the official form and the site's normal security challenge.

See the [browser plugin guide](../../../docs/plugins/browser.md) for host installation and external CDP configuration, and the [executable consumer](examples/consumer.ts) for constructor injection and result handling. Browser provisioning belongs to the application operator; the plugin never installs or launches Chromium or Lightpanda.

```ts
const result = await fiscalTickets.verify(
	{
		code: '12345678',
		number: '0012345678',
		checkCode: 'Ab12C3',
		amount: '100.50',
		issueDate: '2026-10-14',
	},
	{ signal },
)
switch (result.status) {
	case 'matched':
		// Only the five displayed central-ticket fields matched at this observation time.
		console.log(result.checkedAt)
		break
	case 'action_required':
		// Start a new query with onChallenge connected to your human-interaction UI.
		break
	case 'unconfirmed':
		console.log(result.reason)
		break
}
```

The example assumes a running injected `FiscalTicketPlugin`. Input strings preserve leading zeroes. Dates use `YYYY-MM-DD`; signed decimal amounts have at most two fraction digits and sixteen integer digits. Invalid fields reject with `TypeError` without echoing their values.

`FiscalTicketConfig` is the same exported Valibot schema used by the plugin:

| Field           | Default | Meaning                                                                                           |
| --------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `timeoutMs`     | 120000  | Total operation budget, 1000–600000 ms, including human interaction                               |
| `maxConcurrent` | 1       | Accepted concurrent operations, 1–8; excess calls reject with `FiscalTicketError.code === 'BUSY'` |

Each call owns one isolated context and closes it before settling. There is no automatic queue or retry. `TIMEOUT` denotes budget exhaustion and `NOT_RUNNING` denotes stopped local execution. Original Playwright and callback errors reject unchanged. Cancellation closes the page but cannot undo a submitted lookup or restore the website's quota. Configuration changes apply after restart.

An optional `onChallenge: async ({ page, signal }) => { ... }` callback lets a trusted application show/control the same native Page for a human to complete the challenge. The application must implement that interaction; the plugin supplies no remote-desktop UI or CAPTCHA solver. It calls the callback at most once and stops waiting at cancellation/deadline. The callback must honor `signal` for its own external IO, must not close the page, and must not retain it after completion. With no callback, the result is `action_required` and the context closes. After the callback completes, the plugin continues observing within the original deadline so the website can finish processing; a persistent challenge eventually times out.

`matched` is a timestamped observation of five matching central-government DOM fields, not independent authenticity certification. Local-government iframe results, malformed records and remote messages yield `unconfirmed`. `message` can include sensitive website text; render it as text and choose deliberately whether to store it.

The implementation has deterministic host/DOM-fixture tests. Live-site, CAPTCHA and external Lightpanda compatibility require endpoint-based validation. See [design and evidence](DESIGN.md) for selectors, lifecycle boundaries and known limits.
