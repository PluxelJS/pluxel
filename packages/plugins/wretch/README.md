# @pluxel/wretch

Forkable HTTP client plugin powered by `wretch` (v3).

## Configuration

The config key is `wretch`.

```ts
host.setConfig(WretchPlugin, {
  wretch: {
    defaults: {
      baseUrl: 'https://api.example.com/',
      headers: { 'x-app': 'pluxel' },
      // options: { mode: 'cors', cache: 'no-store' }, // fetch RequestInit (loose)
    },
    clients: {
      prod: { baseUrl: 'https://api.example.com/' },
      staging: { baseUrl: 'https://staging-api.example.com/' },
    },
    defaultClient: 'prod',
  },
})
```

## Usage

Only API: `client(name?) => wretch instance`.

```ts
const w = host.getOrThrow(WretchPlugin).client() // default client
const data = await w.get('/v1/ping').json<{ ok: boolean }>()
```

```ts
const w = host.getOrThrow(WretchPlugin).client('staging')
await w.json({ name: 'hello' }).post('/v1/items').res()
```
