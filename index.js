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
  }

  async makeRequest(
    methodName,
    args,
    { requestEncoding, responseEncoding, rpcTimeout, totalTimeout } = {}
  ) {
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
        try {
          return await Promise.race([
            totalTimeoutAbort,
            this.statelessRpc.makeRequest(key, methodName, args, {
              timeout: rpcTimeout,
              requestEncoding,
              responseEncoding
            })
          ])
        } catch (e) {
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
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  destroy() {
    if (this.rateLimit) this.rateLimit.destroy()
  }
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
