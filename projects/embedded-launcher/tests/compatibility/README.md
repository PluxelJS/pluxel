# Embedded npm compatibility fixture

`portable.ts` exports the same `dispatch(string): Promise<string>` and `close(): Promise<void>` interface as the embedded execution entry. It uses the actual runtime globals and performs real HTTP requests. It neither starts a Host nor replaces Fetch, WebCrypto, streams, or abort APIs.

From the repository root, after preparing LLRT and installing dependencies, build and run the real embedded check:

```sh
pnpm --filter @embedded-launcher/app build:plugins
cargo run --locked --manifest-path projects/embedded-launcher/native/Cargo.toml --bin compatibility-check -- projects/embedded-launcher/dist
```

The Rust runner owns a bounded local TCP HTTP echo server and repeats the complete matrix across three runtime instances in the same native process. Each cycle verifies all fourteen named cases, closes the runtime, and checks its live count returns to zero. The server must observe exactly twenty-four real HTTP requests in total. The runner prints phase JSON on stderr and final evidence JSON on stdout. An assertion abort during runtime destruction is a failed run even if dispatch already returned fourteen successful cases.

For fault isolation only, pass an exact case name as the second binary argument (after the dist path), for example `"Symbol.dispose + Symbol.asyncDispose"`. This sends optional `params.case` and reports `scope: "single-case-diagnostic"`; it cannot substitute for the default full matrix. Unknown names are rejected.

Build this entry as `dist/compatibility.mjs` with browser export conditions. In particular, Axios must select its browser build and retain its default adapter selection; forcing an adapter would test a different contract. Record resolved package versions, build conditions, residual imports, and the exact LLRT revision alongside each run. The research baseline versions are Zod 4.6.5, YAML 2.9.1, semver 7.8.5, noble ciphers/hashes 2.4.0, jose 6.2.12, Wretch 3.0.9, and Axios 1.20.0. Installed versions are authoritative; these numbers are not evidence that a build used them.

Call `dispatch` with this JSON string, replacing the URL with a listening HTTP echo server:

```json
{
	"jsonrpc": "2.0",
	"id": 1,
	"method": "compatibility.run",
	"params": { "echoUrl": "http://127.0.0.1:18764/echo" }
}
```

The endpoint must accept GET and POST, consume the complete request body, and return HTTP 200 with `Content-Type: application/json` and this shape:

```json
{
	"type": "<received Content-Type or empty string>",
	"body": "<raw request body decoded as UTF-8>",
	"bodyBytes": [0, 1, 255],
	"headers": { "content-type": "<received header value>" }
}
```

`bodyBytes` must contain **all original request bytes** as integers, without parsing or reconstructing multipart content. `headers` contains the actual request headers as string values; an omitted Origin header must remain absent. This lets the fixture check the LLRT multipart fix with ASCII, non-ASCII, and binary payloads, and check the real outbound Origin behavior.

The JSON-RPC response has `result.ok` and fourteen named `result.cases`. The runner must assert `result.ok === true`, fourteen successful cases, a matching response ID, and successful runtime close. A resolved dispatch or zero process exit status alone does not constitute a pass. Each case records its own failure so one broken package does not hide later scenarios. Module initialization failures reject before dispatch and must also fail the run. Use an outer bounded acceptance deadline to diagnose hangs, without replacing runtime APIs.

`close` rejects new dispatches, aborts the fixture's network lifetime, and drains the active run. No scenario proves arbitrary npm compatibility, lifecycle ownership of direct global Fetch, TLS correctness, or long-term resource stability. Those remain separate acceptance checks.
