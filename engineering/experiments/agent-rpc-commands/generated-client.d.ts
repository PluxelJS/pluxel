// Generated from the proposal's declaration-only Command stand-in.
type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { code: string; message: string; callId: string; outcome: 'not_started' | 'unknown' } };
export interface RecordsApi {
  write(input: { "id": string; "count": number; "offset": string }): Promise<RpcResult<{ "operationId": string; "committed": boolean; "counts": { "accepted": number; "rejected": number } }>>;
  read(input: { "id": string }): Promise<RpcResult<{ "id": string; "text": null | string }>>;
}
