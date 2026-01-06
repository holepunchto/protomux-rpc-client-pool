# Protomux RPC Client Pool

Reliably connect to one of a pool of protomux-rpc servers.

Picks a random server to connect to, and keeps connecting to that server, unless it fails to respond, in which case it automatically switches over to another one.

## Install

```
npm i protomux-rpc-client-pool
```

## API

#### `const pool = new ProtomuxRpcClientPool(keys, rpcClient, opts)`

Create a new pool. `keys` is a list of [HyperDHT](https://github.com/holepunchto/hyperdht) servers that expose the same [protomux-rpc](https://github.com/holepunchto/protomux-rpc) service. `rpcClient` is a [Protomux RPC client](https://github.com/holepunchto/protomux-rpc-client) instance.

`opts` include:

- `retries` : the number of times to retry a request with a different server before giving up. Default: 3.
- `rpcTimeout` : the default timeout for a single request attempt, in ms.
- `totalTimeout`: the default timeout for the entire request, in ms. This timeout operates independently of `rpcTimeout`.
- `rateLimit`: bucket rate limit config
- `ratelimit.capacity`: max tokens (burst capacity)
- `ratelimit.intervalMs`: time interval in milliseconds to refill 1 token

#### `await pool.makeRequest(methodName, args, opts)`

Makes a request for the specifed `methodName` to one of the servers in the pool, passing the `args`. If the server fails to respond, it automatically retries with other servers.

Throws a `ProtomuxRpcClientPoolError.TOO_MANY_RETRIES` error if the request attempt fails `pool.retries` times.
Throws a `ProtomuxRpcClientPoolError.POOL_REQUEST_TIMEOUT` error if the request exceeds total timeout.

`opts` include:

- `requestEncoding` the request encoding of the RPC service
- `responseEncoding` the response encoding of the RPC service
- `rpcTimeout` the timeout to use for each request attempt (in ms). Defaults to `pool.rpcTimeout`.
- `totalTimeout` the timeout for entire request (in ms). Defaults to `pool.totalTimeout`.

#### `pool.destroy()`

Destroy the pool, cleanup the ratelimit
