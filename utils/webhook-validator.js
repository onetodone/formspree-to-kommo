const crypto = require('crypto')

/**
 * Webhook validation utilities for secure webhook handling
 */
class WebhookValidator {
  constructor() {
    this.secret = process.env.WEBHOOK_SECRET
  }

  /**
   * Validate webhook signature from Formspree
   * @param {string} payload - Raw webhook payload
   * @param {string} signature - Signature from webhook headers
   * @returns {boolean} - True if signature is valid
   */
  validateSignature(payload, signature) {
    if (!this.secret) {
      // If no secret is configured, skip validation (development mode)
      return true
    }

    if (!signature) {
      return false
    }

    try {
      // Remove 'sha256=' prefix if present
      const sig = signature.replace('sha256=', '')

      // Create HMAC hash
      const hmac = crypto.createHmac('sha256', this.secret)
      hmac.update(payload, 'utf8')
      const calculated = hmac.digest('hex')

      // Compare signatures using constant-time comparison
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(calculated, 'hex'))
    } catch (error) {
      console.error(error)
      return false
    }
  }

  /**
   * Validate webhook timestamp to prevent replay attacks
   * @param {string} timestamp - Timestamp from webhook headers
   * @param {number} toleranceSeconds - Maximum age in seconds (default: 300 = 5 minutes)
   * @returns {boolean} - True if timestamp is within tolerance
   */
  validateTimestamp(timestamp, toleranceSeconds = 300) {
    if (!timestamp) {
      return false
    }

    try {
      const webhookTime = parseInt(timestamp, 10)
      const currentTime = Math.floor(Date.now() / 1000)
      const timeDifference = Math.abs(currentTime - webhookTime)

      return timeDifference <= toleranceSeconds
    } catch (error) {
      console.error(error)
      return false
    }
  }

  /**
   * Validate that the webhook payload contains required fields
   * @param {object} payload - Webhook payload object
   * @returns {object} - Validation result with isValid and errors
   */
  validatePayload(payload) {
    const errors = []

    // Check if payload has submission object (Formspree format)
    if (!payload.submission || typeof payload.submission !== 'object') {
      errors.push('Missing or invalid submission object')
      return {
        isValid: false,
        errors,
      }
    }

    const submission = payload.submission

    // Check for email in submission (multiple possible field names)
    const email =
      submission.email || submission.Email || submission['E-mail'] || submission['email'] || submission['EMAIL']
    if (!email || typeof email !== 'string') {
      errors.push('Missing or invalid email field in submission')
    } else if (!this.isValidEmail(email)) {
      errors.push('Invalid email format ' + email)
    }

    // Check for form ID (optional but recommended)
    const formId = payload.form || payload._form_id
    if (formId && typeof formId !== 'string') {
      errors.push('Invalid form ID format')
    }

    // Check for honeypot field (should be empty)
    if (submission._gotcha && submission._gotcha.trim() !== '') {
      errors.push('Honeypot field detected - possible spam')
    }

    // Check payload size (prevent DoS)
    const payloadSize = JSON.stringify(payload).length
    if (payloadSize > 50000) {
      // 50KB limit
      errors.push('Payload too large')
    }

    return {
      isValid: errors.length === 0,
      errors,
    }
  }

  /**
   * Simple email validation
   * @param {string} email - Email to validate
   * @returns {boolean} - True if email format is valid
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
  }

  /**
   * Check if IP address is from allowed sources
   * @param {string} ip - Client IP address
   * @returns {boolean} - True if IP is allowed
   */
  validateSourceIP(ip) {
    // Formspree IP ranges and common AWS/cloud IPs
    const allowedIPs = [
      '54.236.102.109',
      '54.236.102.110',
      '54.236.102.111',
      '52.91.67.80',
      '18.212.157.223',
      '54.221.112.108',
    ]

    // Allow common AWS IP ranges for Formspree (they use AWS)
    const allowedRanges = [
      /^52\./, // AWS us-east-1 range
      /^54\./, // AWS us-east-1 range
      /^18\./, // AWS us-east-1 range
      /^3\./, // AWS us-east-1 range
    ]

    // For development, allow localhost
    if (process.env.NODE_ENV !== 'production') {
      allowedIPs.push('127.0.0.1', '::1', '::ffff:127.0.0.1')
    }

    // Check exact IP matches first
    if (allowedIPs.includes(ip)) {
      return true
    }

    // Check IP ranges for cloud providers
    return allowedRanges.some((range) => range.test(ip))
  }

  /**
   * Comprehensive webhook validation
   * @param {object} request - Fastify request object
   * @param {object} payload - Parsed webhook payload
   * @returns {object} - Validation result
   */
  validateWebhook(request, payload) {
    const errors = []

    // Validate signature if secret is configured and signature is present
    if (this.secret && process.env.STRICT_SIGNATURE_VALIDATION === 'true') {
      const signature = request.headers['x-formspree-signature'] || request.headers['x-hub-signature-256']
      if (signature && !this.validateSignature(request.rawBody, signature)) {
        errors.push('Invalid webhook signature')
      } else if (!signature) {
        errors.push('No webhook signature provided, but strict validation is enabled')
      }
    } else if (this.secret) {
      // Log but don't fail if signature validation is not strict
      const signature = request.headers['x-formspree-signature'] || request.headers['x-hub-signature-256']
      if (!signature) {
        console.log('No webhook signature provided (non-strict mode)')
      } else if (!this.validateSignature(request.rawBody, signature)) {
        console.warn('Webhook signature validation failed (non-strict mode)')
      }
    }

    // Validate timestamp if present (Formspree may not send this)
    const timestamp = request.headers['x-formspree-timestamp']
    if (timestamp && !this.validateTimestamp(timestamp)) {
      errors.push('Webhook timestamp is too old or invalid')
    }

    // Validate payload structure
    const payloadValidation = this.validatePayload(payload)
    if (!payloadValidation.isValid) {
      errors.push(...payloadValidation.errors)
    }

    // Validate source IP in production
    if (process.env.NODE_ENV === 'production' && process.env.STRICT_IP_VALIDATION === 'true') {
      const clientIP = request.ip || request.connection.remoteAddress
      if (!this.validateSourceIP(clientIP)) {
        console.warn(`Webhook from unrecognized IP: ${clientIP}`)
        errors.push(`Unauthorized source IP: ${clientIP}`)
      }
    } else if (process.env.NODE_ENV === 'production') {
      // Just log the IP for monitoring purposes
      const clientIP = request.ip || request.connection.remoteAddress
      const forwardedFor = request.headers['x-forwarded-for']
      console.log(`Webhook received from IP: ${clientIP} (Forwarded: ${forwardedFor})`)
    }

    return {
      isValid: errors.length === 0,
      errors,
    }
  }
}

module.exports = WebhookValidator
