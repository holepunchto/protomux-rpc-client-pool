const IdEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const BucketRateLimiter = require('bucket-rate-limit')
const safetyCatch = require('safety-catch')
const PoolError = require('./lib/errors')

class ProtomuxRpcClientPool {
  constructor(
    keys,
    rpcClient,
    { totalTimeout = 10_000, retries = 3, rpcTimeout = 3_000, rateLimit = {} } = {}
  ) {
    // TODO: ensure failover is to a random key too (for example by random-sorting the keys when passed-in)
    this.keys = keys.map(IdEnc.decode)
    this.statelessRpc = rpcClient
    this.totalTimeout = totalTimeout
    this.retries = retries
    this.rpcTimeout = rpcTimeout
    this.chosenKey = pickRandom(this.keys)
    this.rateLimit =
      rateLimit.capacity === -1
        ? null
        : new BucketRateLimiter(rateLimit.capacity || 50, rateLimit.intervalMs || 200)
    this.stats = {
      makeRequestAttempted: 0,
      makeRequestFailed: {},
      makeRequestSucceed: 0,
      tryAttempted: {},
      tryFailed: {},
      trySucceeded: {}
    }
  }

  async makeRequest(
    methodName,
    args,
    { requestEncoding, responseEncoding, rpcTimeout, totalTimeout } = {}
  ) {
    this.stats.makeRequestAttempted++

    totalTimeout = totalTimeout || this.totalTimeout
    rpcTimeout = rpcTimeout || this.rpcTimeout

    let timer = null

    const totalTimeoutAbort = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timer = null
        reject(PoolError.POOL_REQUEST_TIMEOUT())
      }, totalTimeout)
    })
    totalTimeoutAbort.catch(safetyCatch)

    try {
      if (this.rateLimit) await this.rateLimit.wait({ abort: totalTimeoutAbort })

      let key = this.chosenKey

      for (let i = 0; i < this.retries; i++) {
        const serverKey = IdEnc.normalize(key)
        increment(this.stats.tryAttempted, [i, serverKey])

        try {
          const result = await Promise.race([
            totalTimeoutAbort,
            this.statelessRpc.makeRequest(key, methodName, args, {
              timeout: rpcTimeout,
              requestEncoding,
              responseEncoding
            })
          ])

          increment(this.stats.trySucceeded, [i, serverKey])
          this.stats.makeRequestSucceed++
          return result
        } catch (e) {
          increment(this.stats.tryFailed, [i, serverKey, e.code ? e.code : 'UNKNOWN'])

          // TODO: figure out other errors that should result in a retry
          if (
            e.code === 'REQUEST_TIMEOUT' ||
            e.code === 'CHANNEL_CLOSED' ||
            e.code === 'TIMEOUT_EXCEEDED'
          ) {
            if (b4a.equals(key, this.chosenKey)) {
              this.chosenKey = key = pickNext(this.keys, key)
            } else {
              // Some other request already rotated the key
              key = this.chosenKey
            }
            continue
          }
          throw e
        }
      }

      throw PoolError.TOO_MANY_RETRIES()
    } catch (e) {
      increment(this.stats.makeRequestFailed, [e.code ? e.code : 'UNKNOWN'])
      throw e
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  event(methodName, args, { requestEncoding } = {}) {
    this._event(methodName, args, { requestEncoding }).catch(safetyCatch)
  }

  async _event(methodName, args, { requestEncoding } = {}) {
    let timer = null
    const totalTimeoutAbort = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timer = null
        reject(PoolError.POOL_REQUEST_TIMEOUT())
      }, this.totalTimeout)
      timer.unref()
    })
    totalTimeoutAbort.catch(safetyCatch)

    if (this.rateLimit) await this.rateLimit.wait({ abort: totalTimeoutAbort })
    if (timer) {
      clearTimeout(timer)
    }

    this.statelessRpc.event(this.chosenKey, methodName, args, {
      requestEncoding
    })
  }

  destroy() {
    if (this.rateLimit) this.rateLimit.destroy()
  }

  registerMetrics(promClient, { prefix = 'protomux_rpc_client_pool_' } = {}) {
    const self = this

    new promClient.Gauge({
      name: `${prefix}make_request_attempted`,
      help: 'The total number of makeRequest calls attempted',
      collect() {
        this.set(self.stats.makeRequestAttempted)
      }
    })

    new promClient.Gauge({
      name: `${prefix}make_request_failed`,
      help: 'The total number of failed makeRequest calls',
      labelNames: ['code'],
      collect() {
        for (const [key, count] of Object.entries(self.stats.makeRequestFailed)) {
          const [code] = key.split('\0')
          this.set({ code }, count)
        }
      }
    })

    new promClient.Gauge({
      name: `${prefix}make_request_succeed`,
      help: 'The total number of successful makeRequest calls',
      collect() {
        this.set(self.stats.makeRequestSucceed)
      }
    })

    new promClient.Gauge({
      name: `${prefix}try_attempted`,
      help: 'The total number of individual request tries attempted',
      labelNames: ['try', 'serverKey'],
      collect() {
        for (const [key, count] of Object.entries(self.stats.tryAttempted)) {
          const [i, serverKey] = key.split('\0')
          this.set({ try: i, serverKey }, count)
        }
      }
    })

    new promClient.Gauge({
      name: `${prefix}try_failed`,
      help: 'The total number of failed individual request tries',
      labelNames: ['try', 'serverKey', 'code'],
      collect() {
        for (const [key, count] of Object.entries(self.stats.tryFailed)) {
          const [i, serverKey, code] = key.split('\0')
          this.set({ try: i, serverKey, code }, count)
        }
      }
    })

    new promClient.Gauge({
      name: `${prefix}try_succeeded`,
      help: 'The total number of successful individual request tries',
      labelNames: ['try', 'serverKey'],
      collect() {
        for (const [key, count] of Object.entries(self.stats.trySucceeded)) {
          const [i, serverKey] = key.split('\0')
          this.set({ try: i, serverKey }, count)
        }
      }
    })
  }
}

function increment(counts, keys) {
  const key = keys.join('\0')
  counts[key] = (counts[key] || 0) + 1
}

function pickRandom(keys) {
  return keys[Math.floor(Math.random() * keys.length)]
}

function pickNext(keys, key) {
  let foundI = 0
  for (let i = 0; i < keys.length; i++) {
    if (b4a.equals(keys[i], key)) {
      foundI = i
      break
    }
  }

  return keys[(foundI + 1) % keys.length]
}

module.exports = ProtomuxRpcClientPool
