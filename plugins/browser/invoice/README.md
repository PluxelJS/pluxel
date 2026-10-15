# @pluxel/invoice

Experimental VLM transcription and browser-assisted verification of Chinese fiscal tickets and twenty-digit digital tax invoices. `InvoicePlugin` uses `PlaywrightPlugin` for an externally operated browser and keeps both fiscal and tax portal adapters inside this package, sharing one configuration, admission limit, deadline and context lifecycle. It installs no browser and needs no Workbench or task database.

See the [invoice guide](../../../docs/plugins/invoice.md) for supported documents, configuration, credentials, results, cancellation and limitations. The [application](examples/application.ts) shows explicit environment/Vault bindings; the [consumer](examples/consumer.ts) handles review and human-interaction outcomes. [Design and evidence](DESIGN.md) distinguishes live observations from synthetic regression coverage.

```ts
const result = await invoices.verifyImage({ bytes, mimeType: 'image/jpeg' }, { signal })
if (result.status === 'needs_review') {
	console.log(result.fields)
} else {
	console.log(result.verification.status)
}
```

The result separates model transcription (`extraction`) from official verification. A match provides typed `details` (parties, amounts and line items), `issues` for unavailable/ambiguous mappings, and raw `evidence` for audit. Unknown data stays null; a match is not approval for reimbursement.

This assumes an injected, running `InvoicePlugin`. `extract(image, { signal })` performs transcription alone; `verify(input, options)` accepts already validated domain inputs. Each call owns its IO and closes acquired browser contexts before settling. Model transport failures reject; inspect the documented error codes, and do not blindly retry a possibly submitted website query.

Checks: `vp run test`, `vp run typecheck`, `vp run test:browser` (requires a Playwright Chromium installation). `vp run test:live` explicitly sends supplied images to an external model and may submit official queries; see the guide before running it.
