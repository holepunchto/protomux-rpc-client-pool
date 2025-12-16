const IdEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const PoolError = require('./lib/errors')

class ProtomuxRpcClientPool {
  constructor(keys, rpcClient, { retries = 3, timeout = 3000, breakoutTimeout = 500 } = {}) {
    // TODO: ensure failover is to a random key too (for example by random-sorting the keys when passed-in)
    this.keys = keys.map(IdEnc.decode)
    this.statelessRpc = rpcClient
    this.retries = retries
    this.timeout = timeout
    this.breakoutTimeout = breakoutTimeout
    this._breakoutTimers = new Set()
    this.chosenKey = pickRandom(this.keys)
  }

  _shouldRetry(e) {
    switch (e.code) {
      case 'RATE_LIMIT_EXCEEDED':
      case 'TOO_MANY_REQUESTS':
        return true
      default:
        return false
    }
  }

  _shouldFailover(e) {
    switch (e.code) {
      case 'REQUEST_TIMEOUT':
      case 'CHANNEL_CLOSED':
      case 'TIMEOUT_EXCEEDED':
      case 'RATE_LIMIT_EXCEEDED':
      case 'TOO_MANY_REQUESTS':
        return true
      default:
        return false
    }
  }

  _removeKeyTemporarily(key) {
    const index = this.keys.findIndex((k) => b4a.equals(k, key))
    if (index !== -1) {
      this.keys.splice(index, 1)
    }
    const timer = setTimeout(() => {
      this._breakoutTimers.delete(timer)

      if (this.keys.findIndex((k) => b4a.equals(k, key)) === -1) {
        this.keys.push(key)
      }
    }, this.failoverTimeout)
    this._breakoutTimers.add(timer)
  }

  async makeRequest(methodName, args, { requestEncoding, responseEncoding, timeout } = {}) {
    timeout = timeout || this.timeout

    let key = this.chosenKey
    for (let i = 0; i < this.retries; i++) {
      try {
        return await this.statelessRpc.makeRequest(key, methodName, args, {
          timeout,
          requestEncoding,
          responseEncoding
        })
      } catch (e) {
        if (this._shouldFailover(e)) {
          if (b4a.equals(key, this.chosenKey)) {
            this._removeKeyTemporarily(key)
            this.chosenKey = pickNext(this.keys, key, e)
          }
        }
        if (this._shouldRetry(e)) {
          if (b4a.equals(key, this.chosenKey)) {
            this.chosenKey = key = pickNext(this.keys, key, e)
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
  }

  destroy() {
    this._breakoutTimers.forEach((timer) => clearTimeout(timer))
    this._breakoutTimers.clear()
  }
}

function pickRandom(keys) {
  return keys[Math.floor(Math.random() * keys.length)]
}

function pickNext(keys, key, cause) {
  if (keys.length === 0) {
    throw PoolError.NO_SERVICES_AVAILABLE(cause)
  }
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
