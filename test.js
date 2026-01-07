const ProtomuxRPC = require('protomux-rpc')
const HyperDHT = require('hyperdht')
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const cenc = require('compact-encoding')
const ProtomuxRpcClient = require('protomux-rpc-client')
const b4a = require('b4a')

const Pool = require('.')

const DEBUG = true

test('happy path', async (t) => {
  const bootstrap = await setupTestnet(t)
  const { server: s1 } = await setupRpcServer(t, bootstrap)
  const { server: s2 } = await setupRpcServer(t, bootstrap)
  const rpcClient = getRpcClient(t, bootstrap)

  const pool = new Pool([s1.publicKey, s2.publicKey], rpcClient)
  t.teardown(() => {
    pool.destroy()
  })
  t.is(pool.retries, 3, 'default retries')
  t.is(pool.rpcTimeout, 3000, 'default rpc timeout')
  t.is(pool.totalTimeout, 10000, 'default total timeout')
  t.is(pool.rateLimit.capacity, 50, 'default rate limit capacity')
  t.is(pool.rateLimit.intervalMs, 200, 'default rate limit interval')

  const res = await pool.makeRequest('echo', 'hi', {
    requestEncoding: cenc.string,
    responseEncoding: cenc.string
  })
  t.is(res, 'hi', 'rpc request processed successfully')
  t.is(rpcClient.nrConnections, 1, '1 connection opened')
  const initKey = pool.chosenKey
  t.is(initKey.byteLength, 32, 'sanity check to ensure it is a valid key')

  for (let i = 0; i < 10; i++) {
    await pool.makeRequest('echo', 'hi', {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    })
  }

  t.is(pool.chosenKey, initKey, 'keeps using the same key')
  t.is(rpcClient.nrConnections, 1, 'sanity check')
})

test('retries with other key if a server is unavailable', async (t) => {
  const bootstrap = await setupTestnet(t)
  const { server: s1, dht: dht1 } = await setupRpcServer(t, bootstrap)
  const { server: s2, dht: dht2 } = await setupRpcServer(t, bootstrap)
  const rpcClient = getRpcClient(t, bootstrap)

  const pool = new Pool([s1.publicKey, s2.publicKey], rpcClient)
  t.teardown(() => {
    pool.destroy()
  })

  {
    const res = await pool.makeRequest('echo', 'hi', {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    })
    t.is(res, 'hi', 'rpc request processed successfully')
  }

  // chosen server goes offline
  let choseS1 = true

  if (b4a.equals(pool.chosenKey, s1.publicKey)) {
    await dht1.destroy()
  } else {
    choseS1 = false
    await dht2.destroy()
  }

  {
    const res = await pool.makeRequest('echo', 'hi', {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    })
    t.is(res, 'hi', 'rpc request processed successfully')
  }

  t.alike(pool.chosenKey, choseS1 ? s2.publicKey : s1.publicKey, 'switched to the other server')
})

test('retries with other key if a request times out', async (t) => {
  const bootstrap = await setupTestnet(t)
  const { server: s1, setDelay: setDelay1 } = await setupRpcServer(t, bootstrap)
  const { server: s2, setDelay: setDelay2 } = await setupRpcServer(t, bootstrap)
  const rpcClient = getRpcClient(t, bootstrap)

  const pool = new Pool([s1.publicKey, s2.publicKey], rpcClient, {
    rpcTimeout: 500,
    totalTimeout: 1500
  })
  t.teardown(() => {
    pool.destroy()
  })

  {
    const res = await pool.makeRequest('echo', 'hi', {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    })
    t.is(res, 'hi', 'rpc request processed successfully')
  }

  // chosen server becomes slow
  let choseS1 = true
  if (b4a.equals(pool.chosenKey, s1.publicKey)) {
    setDelay1(100_000)
  } else {
    choseS1 = false
    setDelay2(100_000)
  }

  {
    const res = await pool.makeRequest('echo', 'hi', {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    })
    t.is(res, 'hi', 'rpc request processed successfully')
  }

  t.alike(pool.chosenKey, choseS1 ? s2.publicKey : s1.publicKey, 'switched to the other server')
})

test('Too-many-retries error if there are too many failed attempts', async (t) => {
  const bootstrap = await setupTestnet(t)
  const rpcClient = getRpcClient(t, bootstrap)

  const pool = new Pool(
    ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)],
    rpcClient,
    { timeout: 100 }
  )
  t.teardown(() => {
    pool.destroy()
  })

  await t.exception(async () => {
    await pool.makeRequest('echo', 'hi')
  }, /TOO_MANY_RETRIES:/)
})

test('Too-many-retries error if there are too many failed attempts', async (t) => {
  const bootstrap = await setupTestnet(t)
  const rpcClient = getRpcClient(t, bootstrap)

  const pool = new Pool(
    ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)],
    rpcClient,
    { timeout: 100 }
  )
  t.teardown(() => {
    pool.destroy()
  })

  await t.exception(async () => {
    await pool.makeRequest('echo', 'hi')
  }, /TOO_MANY_RETRIES:/)
})

test('Total timeout exceeded error if the total timeout is exceeded', async (t) => {
  const bootstrap = await setupTestnet(t)
  const rpcClient = getRpcClient(t, bootstrap)

  const pool = new Pool(
    ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)],
    rpcClient,
    { totalTimeout: 300, retries: 3, rpcTimeout: 200 }
  )
  t.teardown(() => {
    pool.destroy()
  })

  await t.exception(async () => {
    await pool.makeRequest('echo', 'hi')
  }, /POOL_REQUEST_TIMEOUT:/)
})

test('Rate limit exceeded error if the rate limit is exceeded', async (t) => {
  const bootstrap = await setupTestnet(t)
  const { server: s1 } = await setupRpcServer(t, bootstrap)
  const { server: s2 } = await setupRpcServer(t, bootstrap)
  const rpcClient = getRpcClient(t, bootstrap)

  const pool = new Pool([s1.publicKey, s2.publicKey], rpcClient, {
    rateLimit: { capacity: 2, intervalMs: 200 }
  })
  t.teardown(() => {
    pool.destroy()
  })

  let requestFinishedCount = 0

  new Array(5).fill(0).map(async () => {
    const res = await pool.makeRequest('echo', 'hi', {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    })
    t.is(res, 'hi', 'rpc request processed successfully')
    requestFinishedCount++
  })

  // With capacity=2 and tokensPerInterval=1 every 200ms
  // expect 2 to finish quickly, then one more approximately every 200ms.
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(requestFinishedCount, 2, 'burst capacity executed immediately')

  await new Promise((resolve) => setTimeout(resolve, 200)) // ~250ms since start
  t.is(requestFinishedCount, 3, 'one additional request after first refill')

  await new Promise((resolve) => setTimeout(resolve, 200)) // ~450ms since start
  t.is(requestFinishedCount, 4, 'one additional request after second refill')

  await new Promise((resolve) => setTimeout(resolve, 200)) // ~650ms since start
  t.is(requestFinishedCount, 5, 'all requests finished within rate limit')
})

test('No rate limit if capacity set to -1', async (t) => {
  const bootstrap = await setupTestnet(t)
  const { server: s1 } = await setupRpcServer(t, bootstrap)
  const rpcClient = getRpcClient(t, bootstrap)

  const pool = new Pool([s1.publicKey], rpcClient, {
    rateLimit: { capacity: -1 }
  })
  t.teardown(() => {
    pool.destroy()
  })
  t.is(pool.rateLimit, null, 'rate limit not set up')

  let requestFinishedCount = 0

  new Array(10).fill(0).map(async () => {
    await pool.makeRequest('echo', 'hi', {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    })
    requestFinishedCount++
  })

  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(requestFinishedCount, 10, 'no rate limit triggered')
})

async function setupTestnet(t) {
  const testnet = await createTestnet()
  t.teardown(
    async () => {
      await testnet.destroy()
    },
    { order: 1000_000 }
  )
  return testnet.bootstrap
}

async function setupRpcServer(t, bootstrap, { msDelay = 0 } = {}) {
  const dht = new HyperDHT({ bootstrap })
  const server = dht.createServer()

  let nrCons = 0

  server.on('connection', (conn) => {
    if (DEBUG) {
      console.log('RPC connection received')
      conn.on('close', () => {
        console.log('RPC connection closed')
      })
    }
    nrCons++
    const rpc = new ProtomuxRPC(conn, {
      id: server.publicKey,
      valueEncoding: cenc.none
    })
    rpc.respond(
      'echo',
      { requestEncoding: cenc.string, responseEncoding: cenc.string },
      async (req) => {
        if (msDelay > 0) {
          await new Promise((resolve) => {
            const timeout = setTimeout(resolve, msDelay)
            dht.on('close', () => {
              clearTimeout(timeout)
              resolve()
            })
          })
        }
        return req
      }
    )
  })

  t.teardown(
    async () => {
      await dht.destroy()
    },
    { order: 100 }
  )

  await server.listen()
  return {
    server,
    getNrCons: () => nrCons,
    setDelay: (delay) => {
      msDelay = delay
    },
    dht
  }
}

function getRpcClient(t, bootstrap) {
  const dht = new HyperDHT({ bootstrap })
  const rpc = new ProtomuxRpcClient(dht)

  t.teardown(
    async () => {
      await rpc.close()
      await dht.destroy()
    },
    { order: 100 }
  )

  return rpc
}
