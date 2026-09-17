# Shared Management

`@pluxel/management` provides the authenticated control protocol, Host management projection and browser client. It does not create a Runtime, install Workbench, open a listener or configure authentication implicitly.

```ts
import { createHost } from '@pluxel/host'
import { http } from '@pluxel/services/http'
import { persistence } from '@pluxel/services/persistence'
import { managementAccess } from '@pluxel/management/access'
import { management } from '@pluxel/management/service'
import { managementHttp } from '@pluxel/management/http'

const host = await createHost({
	plugins: [],
	services: [
		http(),
		persistence({ mode: 'memory' }),
		managementAccess(),
		management(),
		managementHttp(),
	],
})
await host.start()
```

The selected application launcher attaches its physical carrier to `HttpServer`. `managementHttp()` mounts `/__pluxel/runtime` and `/__pluxel/admin-access`; it borrows the carrier and closes its connections when root admission closes. Its optional `bindings(ctx)` supplies the existing Workbench session factory and artifact handler. Workbench publication and the official browser shell are separate services.

For another carrier, `createManagementEndpoint()` exposes `fetch()` and `prepareUpgrade()`. A successful preparation returns a connection, not a synthetic HTTP 101. The carrier forwards open/message/close and releases rejected or completed upgrades. `ManagementSocket.send()` returns `false` only when its send budget rejects a message; `void` or `true` indicates acceptance.

Pass trusted `ManagementPeer` address, secure-transport and origin facts from the carrier. Missing facts remain unknown; `Host` and `Forwarded` headers do not establish trust. Authentication handoffs, RPC and borrowed Workbench artifacts use the same access authority. Artifact response bodies retain the authentication lease until consumption or cancellation.

Each authenticated control session supplies an abort signal to Host operations. Closing the endpoint rejects queued work before admission. Already admitted mutations settle without rollback, even when their reply cannot reach the disconnected client. Endpoint disposal never closes the borrowed Host or physical listener.

Browser imports live under `/client`, `/react`, `/session` and `/protocol`. They share one authenticated connection with Workbench Views. View `host.management` methods are borrowed, lifetime-checked facades; they do not create another transport.
