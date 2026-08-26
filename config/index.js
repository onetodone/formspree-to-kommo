const dotenv = require('dotenv')

dotenv.config()

/**
 * Application configuration module
 * Centralizes all environment variable management and validation
 */
class Config {
  constructor() {}

  // Server configuration
  get server() {
    return {
      host: process.env.HOST || '127.0.0.1',
      port: parseInt(process.env.PORT, 10) || 3000,
      environment: process.env.NODE_ENV || 'development',
      domain: process.env.APP_DOMAIN || `localhost:${parseInt(process.env.PORT, 10) || 3000}`,
      baseUrl:
        process.env.APP_BASE_URL ||
        `http://${process.env.APP_DOMAIN || `localhost`}:${parseInt(process.env.PORT, 10) || 3000}`,
    }
  }

  // Kommo API configuration
  get kommo() {
    return {
      kommoUrl: process.env.KOMMO_URL,
      clientId: process.env.KOMMO_CLIENT_ID,
      clientSecret: process.env.KOMMO_CLIENT_SECRET,
      redirectUri: process.env.KOMMO_REDIRECT_URI || `${this.server.baseUrl}/oauth/callback`,
      accessToken: process.env.KOMMO_ACCESS_TOKEN,
      refreshToken: process.env.KOMMO_REFRESH_TOKEN,
      // Default field values for lead creation
      defaultPipelineId: parseInt(process.env.KOMMO_DEFAULT_PIPELINE_ID, 10) || null,
    }
  }

  // Security configuration
  get security() {
    return {
      webhookSecret: process.env.WEBHOOK_SECRET,
      strictSignatureValidation: process.env.STRICT_SIGNATURE_VALIDATION === 'true',
      strictIpValidation: process.env.STRICT_IP_VALIDATION === 'true',
      corsOrigins: this.parseCorsOrigins(),
      rateLimit: {
        max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
        timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
      },
    }
  }

  // Logging configuration
  get logging() {
    return {
      level: process.env.LOG_LEVEL || 'info',
    }
  }

  /**
   * Parse CORS origins from environment variable
   */
  parseCorsOrigins() {
    const origins = process.env.CORS_ORIGINS || 'https://formspree.io'
    return origins.split(',').map((origin) => origin.trim())
  }

  /**
   * Get all configuration as object (for debugging)
   */
  getAll() {
    return {
      server: this.server,
      kommo: {
        ...this.kommo,
        // Hide sensitive data
        clientSecret: this.kommo.clientSecret ? '***' : undefined,
        accessToken: this.kommo.accessToken ? '***' : undefined,
        refreshToken: this.kommo.refreshToken ? '***' : undefined,
      },
      security: {
        ...this.security,
        webhookSecret: this.security.webhookSecret ? '***' : undefined,
      },
      logging: this.logging,
    }
  }
}

// Export singleton instance
const config = new Config()
module.exports = { Config, config }
module.exports.default = config
