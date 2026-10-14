# Fiscal ticket browser adapter

`FiscalTicketPlugin` is an experimental, local browser adapter for the Ministry of Finance's national fiscal electronic ticket portal. It depends on the concrete `PlaywrightPlugin` through constructor injection. It owns no browser installation, process, CDP endpoint, HTTP service, task database or workbench UI. It works without Workbench or persistence.

## Evidence and supported flow

The implementation is based on public assets fetched on 2026-10-14, without submitting any ticket or executing anti-debugging code:

- [Portal](https://pjcy.mof.gov.cn/html/index.html#/home).
- [Current application bundle](https://pjcy.mof.gov.cn/static/js/app.7fd3f2ee.js): desktop `form#idform`, code/number/check-code `maxlength` 8/10/6, fourth child amount input, `.datePicker input`, `.findbtn` submit, `.diaVerify` security challenge, `.wrapper_billshow` result wrapper.
- [Public settings](https://pjcy.mof.gov.cn/globalSetting.js?q=1.1): current login switches and per-ticket daily query limit. These remain site-owned and are not hard-coded as permanent guarantees.
- [Official check instructions](https://pjcy.mof.gov.cn/static/js/chunk-6fdd96ae.244356f0.js): an unsuccessful query may display “票据不存在，请您核对后再次查验。”. This is not interpreted as proof of forgery.

The central-government result has three `.bill-content` templates and duplicated field IDs. The site fills one template, converts it to a canvas-backed image and hides the source markup. Read all templates inside the displayed result wrapper and accept exactly one populated, readable record. Compare code, number, check code, date and amount against the copied request. Money comparison uses integer decimal cents, including negative amounts; no floating point comparison. `matched` reports only matching DOM fields observed at `checkedAt`, not cryptographic signature validation, legal authenticity or current reimbursement status.

Local-government `iframe#Ateon-SetParent-iframe` results are explicitly unsupported. Unknown/multiple/malformed result records produce `unconfirmed`; unknown page layouts that never yield an outcome end with the execution timeout. Website messages remain bounded untrusted text. HTTP status codes, generic success text, result titles and CAPTCHA completion alone cannot produce `matched`.

The site permits negative amounts and six alphanumeric check codes. The adapter imposes a local sixteen-integer-digit amount bound, validates the real calendar date, preserves leading zeroes and does not trim or repair supplied fields. Validation errors identify the field without echoing ticket values.

## Ownership and failure contract

The public `verify` method returns a domain observation: `matched`, `action_required` or `unconfirmed`. These are judgments, so they retain a discriminated union rather than adding Better Result around them. Invalid inputs reject with `TypeError`; bounded execution failures use `FiscalTicketError` (`BUSY`, `TIMEOUT`, `NOT_RUNNING`). Native Playwright and callback failures propagate unchanged; cleanup failure alongside an original failure preserves both through `AggregateError`.

Each accepted call creates an isolated BrowserContext, fills the normal website form and closes the context before settling. The connector owns late acquisition cleanup. The fiscal adapter registers shutdown effects for both its generation and the original caller, aborts accepted work and waits for the operation's context cleanup. No operation accesses the remote browser's default context or pages.

One total deadline includes acquisition, navigation and human interaction. `maxConcurrent` is an admission bound; overflow rejects immediately with `BUSY`. There is no internal queue, deduplication or automatic retry. A timeout or cancellation does not undo a submitted query or restore the site's query quota.

`onChallenge` is a trusted local callback borrowing a native Page, not a serializable RPC capability. It is invoked at most once per call and is awaited until completion or cancellation. Its combined signal covers caller cancellation, host shutdown and the deadline. On cancellation, the adapter stops waiting and closes its page; arbitrary callback code and external IO cannot be forcibly stopped and must honor that signal. A late callback rejection is observed. A missing callback produces `action_required` and closes the page; a later attempt is a new query, not a resumable task. After the callback returns, observation continues within the same deadline so asynchronous website processing can finish. A challenge that remains open until the deadline ends with `TIMEOUT`; the callback is not called a second time.

## Verification and remaining boundary

Tests run real `createTestHost()` lowering, dependency injection and configuration, with only the external CDP SDK boundary replaced. A synthetic DOM fixture exercises the observed desktop selectors, all three hidden templates, leading zeroes, amount/date comparison, unknown messages, iframe results, callback failure, cancellation, busy admission and caller/provider cleanup. The executable consumer example is imported and exercised through the public package API.

These tests do not prove current live website availability, CAPTCHA completion, browser rendering, anti-automation compatibility, or Lightpanda's canvas/CDP behavior. External browser and real-ticket validation remain opt-in follow-up work after the caller supplies an endpoint and ticket. No production ticket data is embedded in fixtures.

GitHub browser-form projects are architectural references only: [ttieli/invoice-verifier](https://github.com/ttieli/invoice-verifier) and [Snowing-ST/Invoice-Checking](https://github.com/Snowing-ST/Invoice-Checking). They target tax invoices, not this fiscal-ticket portal. Their selectors and private API contracts are not used here.
