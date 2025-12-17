class ProtomuxRpcClientPoolError extends Error {
  constructor(msg, code, fn = ProtomuxRpcClientPoolError) {
    super(`${code}: ${msg}`)
    this.code = code

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, fn)
    }
  }

  get name() {
    return 'ProtomuxRpcClientPoolError'
  }

  static TOO_MANY_RETRIES() {
    return new ProtomuxRpcClientPoolError(
      'Too many failed attempts to reach a server',
      'TOO_MANY_RETRIES',
      ProtomuxRpcClientPoolError.TOO_MANY_RETRIES
    )
  }

  static RATE_LIMIT_EXCEEDED() {
    return new ProtomuxRpcClientPoolError(
      'Rate limit exceeded',
      'RATE_LIMIT_EXCEEDED',
      ProtomuxRpcClientPoolError.RATE_LIMIT_EXCEEDED
    )
  }
}

module.exports = ProtomuxRpcClientPoolError
