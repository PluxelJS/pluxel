# Redis connection

This Content reports the active provider connection without copying its persistent configuration or exposing credentials.

::slot[status]

## Connectivity check

Send a Redis `PING` with an optional short payload. The payload is used only for this request and is not retained in the status snapshot.

::slot[ping]
