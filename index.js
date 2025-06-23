const IdEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const PoolError = require('./lib/errors')

class ProtomuxRpcClientPool {
  constructor (keys, rpcClient, { retries = 3, timeout = 3000 } = {}) {
    // TODO: ensure failover is to a random key too (for example by random-sorting the keys when passed-in)
    this.keys = keys.map(IdEnc.decode)
    this.statelessRpc = rpcClient
    this.retries = retries
    this.timeout = timeout
    this.chosenKey = pickRandom(this.keys)
  }

  async makeRequest (methodName, args, { requestEncoding, responseEncoding, timeout } = {}) {
    timeout = timeout || this.timeout

    let key = this.chosenKey
    for (let i = 0; i < this.retries; i++) {
      try {
        return await this.statelessRpc.makeRequest(
          key,
          methodName,
          args,
          { timeout, requestEncoding, responseEncoding }
        )
      } catch (e) {
        // TODO: figure out other errors that should result in a retry
        if (e.code === 'REQUEST_TIMEOUT' || e.code === 'CHANNEL_CLOSED') {
          if (b4a.equals(key, this.chosenKey)) {
            this.chosenKey = key = pickNext(this.keys, key)
          } else { // Some other request already rotated the key
            key = this.chosenKey
          }
          continue
        }
        throw e
      }
    }

    throw PoolError.TOO_MANY_RETRIES()
  }
}

function pickRandom (keys) {
  return keys[Math.floor(Math.random() * keys.length)]
}

function pickNext (keys, key) {
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
