# Redis connections

This Content reports the bounded connection catalog owned by the active provider without copying its persistent configuration or exposing endpoints or credentials.

::slot[status]

## Connectivity check

Choose a configured connection ID and send a Redis `PING` with an optional short payload. The payload is used only for this request and is not retained in the status snapshot.

::slot[ping]
