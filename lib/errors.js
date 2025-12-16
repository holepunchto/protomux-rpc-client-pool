class ProtomuxRpcClientPoolError extends Error {
  constructor(msg, code, fn = ProtomuxRpcClientPoolError, { cause } = {}) {
    super(`${code}: ${msg}`, { cause })
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

  static NO_SERVICES_AVAILABLE(cause) {
    return new ProtomuxRpcClientPoolError(
      'No services are available',
      'NO_SERVICES_AVAILABLE',
      ProtomuxRpcClientPoolError.NO_SERVICES_AVAILABLE,
      {
        cause
      }
    )
  }
}

module.exports = ProtomuxRpcClientPoolError
