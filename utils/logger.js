const fs = require('fs/promises')
const path = require('path')

// Headers worth keeping for debugging. Anything else - notably `authorization`,
// `cookie`, and the HMAC signature headers - is dropped before a request is
// written to disk or handed to the logger.
const SAFE_HEADERS = [
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'accept',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-formspree-timestamp',
]

function pickSafeHeaders(headers = {}) {
  const safe = {}
  for (const name of SAFE_HEADERS) {
    if (headers[name] !== undefined) {
      safe[name] = headers[name]
    }
  }
  return safe
}

/**
 * Logger utility for structured logging
 */
class Logger {
  constructor(fastifyLogger) {
    this.fastifyLogger = fastifyLogger
  }

  /**
   * Log and save request to file
   * @param {Object} request - Fastify request object
   * @param {Object} payload - Request payload
   */
  async logRequest(request, payload) {
    const timestamp = new Date()
    const dateFolder = timestamp.toISOString().split('T')[0] // YYYY-MM-DD
    const timeString = timestamp.toISOString().replace(/[:.]/g, '-').split('.')[0] // HH-mm-ss

    const logData = {
      timestamp: timestamp.toISOString(),
      method: request.method,
      url: request.url,
      headers: pickSafeHeaders(request.headers),
      body: payload,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    }

    // Log to Fastify logger
    this.fastifyLogger.info(logData, 'Incoming webhook request')

    // Save to file
    try {
      const logDir = path.join(__dirname, '..', 'logs', dateFolder)
      await fs.mkdir(logDir, { recursive: true })

      const logFile = path.join(logDir, `${timeString}.json`)
      await fs.writeFile(logFile, JSON.stringify(logData, null, 2))

      this.fastifyLogger.info(`Request logged to: ${logFile}`)
    } catch (error) {
      this.fastifyLogger.error(error, 'Failed to save request log to file')
    }

    return logData
  }

  /**
   * Log Kommo API response
   * @param {Object} response - API response
   * @param {boolean} success - Whether the request was successful
   * @param {string} operation - Description of the operation
   */
  logKommoResponse(response, success, operation) {
    const logData = {
      timestamp: new Date().toISOString(),
      operation,
      success,
      response: response,
    }

    if (success) {
      this.fastifyLogger.info(logData, `Kommo ${operation} successful`)
    } else {
      this.fastifyLogger.error(logData, `Kommo ${operation} failed`)
    }
  }
  /**
   * Save payload data to payload directory
   * @param {Object} payload - Formspree payload
   * @param {string} email - Contact email for filename
   */
  async savePayloadData(payload, email) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const sanitizedEmail = email.replace(/[^a-zA-Z0-9@.-]/g, '_')
      const filename = `${sanitizedEmail}_${timestamp}.json`

      const dataDir = path.join(__dirname, '..', 'db', 'payload')
      await fs.mkdir(dataDir, { recursive: true })

      const filePath = path.join(dataDir, filename)
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2))

      this.fastifyLogger.info(`Payload saved to: ${filePath}`)
      return filePath
    } catch (error) {
      this.fastifyLogger.error(error, 'Failed to save payload data')
      throw error
    }
  }
}

module.exports = Logger
