const IdEnc = require('hypercore-id-encoding')
const b4a = require('b4a')

class ProtomuxRpcClientPool {
  constructor (keys, rpcClient, { nrRetries = 3, requestTimeout = 3000 } = {}) {
    // TODO: ensure failover is to a random key too (for example by random-sorting the keys when passed-in)
    this.keys = keys.map(IdEnc.decode)
    this.statelessRpc = rpcClient
    this.nrRetries = nrRetries
    this.requestTimeout = requestTimeout
    this.chosenKey = pickRandom(this.keys)
  }

  async makeRequest (methodName, args, { requestEncoding, responseEncoding, timeout } = {}) {
    timeout = timeout || this.requestTimeout

    let key = this.chosenKey
    for (let i = 0; i < this.nrRetries; i++) {
      try {
        return await this.statelessRpc.makeRequest(
          key,
          methodName,
          args,
          { timeout, requestEncoding, responseEncoding }
        )
      } catch (e) {
        if (e.code === 'REQUEST_TIMEOUT') {
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
    throw new Error('Too many timeouts') // TODO: proper error
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
