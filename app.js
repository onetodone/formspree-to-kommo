'use strict'

const path = require('node:path')
const AutoLoad = require('@fastify/autoload')
const Fastify = require('fastify')
const dotenv = require('dotenv')
const { config } = require('./config')

dotenv.config()

const fastify = Fastify({
  logger: {
    level: config.logging.level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-formspree-signature"]',
        'req.headers["x-hub-signature-256"]',
        'headers.authorization',
        'headers.cookie',
        'headers["x-formspree-signature"]',
        'headers["x-hub-signature-256"]',
        'access_token',
        'refresh_token',
        '*.access_token',
        '*.refresh_token',
        'response.access_token',
        'response.refresh_token',
      ],
      censor: '[redacted]',
    },
  },
})

// Preserve the raw request body so webhook signature validation can verify it
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
  request.rawBody = body
  try {
    done(null, body.length ? JSON.parse(body) : {})
  } catch (err) {
    err.statusCode = 400
    done(err, undefined)
  }
})

// Register security and utility plugins only in production
if (process.env.NODE_ENV === 'production') {
  fastify.register(require('@fastify/rate-limit'), {
    max: 100,
    timeWindow: '1 minute',
    hookOnExceeded: async (request, reply, type) => {
      fastify.log.warn(`Rate limit exceeded: ${request.ip} - ${type}`)
    },
  })

  fastify.register(require('@fastify/helmet'), {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })

  fastify.register(require('@fastify/cors'), {
    origin: (origin, callback) => {
      // Allow Formspree and localhost for development
      const allowedOrigins = [
        'https://formspree.io',
        'https://submit-form.com',
        /^https:\/\/.*\.formspree\.io$/,
        /^https:\/\/.*\.submit-form\.com$/,
      ]

      // Allow requests with no origin (like Postman, curl)
      if (!origin) return callback(null, true)

      const isAllowed = allowedOrigins.some((allowed) =>
        typeof allowed === 'string' ? allowed === origin : allowed.test(origin),
      )

      callback(null, isAllowed)
    },
    credentials: false,
    methods: ['GET', 'POST'],
  })
}

// Redirect www to non-www and http to https
fastify.addHook('preHandler', async (request, reply) => {
  if (process.env.NODE_ENV !== 'production') {
    return
  }

  const host = request.headers.host
  const protocol =
    request.headers['x-forwarded-proto'] || (request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http')
  const url = request.url

  // Get the canonical domain from environment (remove port if present)
  const canonicalDomain = process.env.APP_DOMAIN
    ? process.env.APP_DOMAIN.split(':')[0]
    : host
      ? host.replace(/^www\./, '')
      : host

  const needsRedirect =
    (host && host.startsWith('www.')) ||
    protocol === 'http' ||
    (host && canonicalDomain && host !== canonicalDomain && !host.startsWith('localhost'))

  if (needsRedirect) {
    const targetDomain = canonicalDomain || (host ? host.replace(/^www\./, '') : 'localhost')
    const redirectUrl = `https://${targetDomain}${url}`

    fastify.log.info(`Redirecting ${protocol}://${host}${url} to ${redirectUrl}`)

    return reply.code(301).header('Location', redirectUrl).send()
  }
})

// Load plugins from ./plugins
fastify.register(AutoLoad, {
  dir: path.join(__dirname, 'plugins'),
  options: {},
})

// Load routes from ./routes
fastify.register(AutoLoad, {
  dir: path.join(__dirname, 'routes'),
  options: {},
})

// Fail closed: a webhook secret is required unless unsigned webhooks are explicitly allowed
if (!process.env.WEBHOOK_SECRET && process.env.WEBHOOK_ALLOW_UNSIGNED !== 'true') {
  fastify.log.fatal(
    'WEBHOOK_SECRET is not set. Configure it, or set WEBHOOK_ALLOW_UNSIGNED=true to accept unsigned webhooks (insecure).',
  )
  process.exit(1)
}

// Start the server
const start = async () => {
  try {
    await fastify.listen({
      port: process.env.PORT || 3000,
      host: process.env.HOST || '127.0.0.1',
    })
    fastify.log.info(`🚀 Server listening at http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
