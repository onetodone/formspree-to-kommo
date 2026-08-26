'use strict'

const Logger = require('../../utils/logger.js')
const SentRegistry = require('../../utils/registry.js')
const KommoService = require('../../services/kommo.js')
const WebhookValidator = require('../../utils/webhook-validator.js')

module.exports = async function (fastify) {
  // Initialize services
  const logger = new Logger(fastify.log)
  const sentRegistry = new SentRegistry()
  const kommoService = new KommoService(logger)
  const webhookValidator = new WebhookValidator()

  // Middleware to load sent registry on server start
  fastify.addHook('onReady', async () => {
    try {
      await sentRegistry.load()
      fastify.log.info('Sent registry initialized')
    } catch (error) {
      fastify.log.error(error, 'Failed to initialize sent registry')
    }
  })

  /**
   * POST /webhooks/formspree
   * Receive Formspree webhook and proxy to Kommo
   */
  fastify.post(
    '/formspree',
    {
      schema: {
        description: 'Formspree webhook endpoint',
        tags: ['webhooks'],
        body: {
          type: 'object',
          properties: {
            form: { type: 'string' },
            keys: {
              type: 'array',
              items: { type: 'string' },
            },
            submission: { type: 'object' },
          },
          required: ['form', 'submission'],
        },
        response: {
          200: {
            description: 'Success response',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              leadId: { type: 'number' },
              alreadyProcessed: { type: 'boolean' },
            },
          },
          400: {
            description: 'Bad request',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              error: { type: 'string' },
            },
          },
          500: {
            description: 'Internal server error',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const payload = request.body

        // Log the full request
        await logger.logRequest(request, payload)

        // Validate webhook if in production
        if (process.env.NODE_ENV === 'production') {
          const validation = webhookValidator.validateWebhook(request, payload)
          if (!validation.isValid) {
            fastify.log.warn(
              {
                ip: request.ip,
                errors: validation.errors,
              },
              'Webhook validation failed',
            )

            return reply.status(400).send({
              success: false,
              message: 'Webhook validation failed',
              error: validation.errors.join(', '),
            })
          }
        }

        // Extract email from submission for tracking
        const submission = payload.submission
        const email = kommoService.extractFieldValue(submission, ['email', 'Email', 'E-mail', 'EMAIL', 'e-mail'])

        if (!email) {
          return reply.code(400).send({
            success: false,
            message: 'Invalid payload: no email found in submission',
            error: 'MISSING_EMAIL',
          })
        }

        // Save payload to payload directory
        try {
          await logger.savePayloadData(payload, email)
        } catch (error) {
          fastify.log.warn(error, 'Failed to save payload, but continuing processing')
        }

        // Check if this submission was already processed
        const submissionFrom = submission.from || 'unknown',
          normalizedFrom = submissionFrom.toLowerCase().trim().replace(/\s+/g, '-'),
          formspreeDate = submission._date || new Date().toISOString(),
          formUniqueId = payload.form + (submissionFrom ? `-${normalizedFrom}` : '') + `-${formspreeDate}`

        const alreadySent = await sentRegistry.isAlreadySent(email, formUniqueId)

        if (alreadySent) {
          fastify.log.info({ email, formUniqueId }, 'Submission already processed, skipping')
          return reply.send({
            success: true,
            message: 'Submission already processed',
            alreadyProcessed: true,
          })
        }

        // Transform and send to Kommo
        try {
          const { kommoResponse, leadMessage } = await kommoService.createLeadFromFormspree(payload)

          // Extract lead ID from response - incoming leads have different response structure
          let leadId = null
          // For Kommo incoming leads (unsorted), the structure is different
          if (
            kommoResponse._embedded &&
            kommoResponse._embedded.unsorted &&
            kommoResponse._embedded.unsorted.length > 0 &&
            kommoResponse._embedded.unsorted[0]._embedded &&
            kommoResponse._embedded.unsorted[0]._embedded.leads &&
            kommoResponse._embedded.unsorted[0]._embedded.leads.length > 0
          ) {
            leadId = kommoResponse._embedded.unsorted[0]._embedded.leads[0].id
          }

          if (leadId && leadMessage) {
            try {
              await kommoService.addNoteToLead(leadId, leadMessage)
            } catch (noteErr) {
              fastify.log.warn(noteErr, 'Failed to add note to lead')
            }
          }

          // Mark as sent in registry
          await sentRegistry.markAsSent(email, formUniqueId, {
            leadId,
            timestamp: new Date().toISOString(),
            formspreeForm: payload.form,
            kommoResponse: {
              success: true,
              leadId,
              isIncomingLead: true,
            },
          })

          fastify.log.info(
            {
              email,
              formUniqueId,
              leadId,
              kommoResponse: kommoResponse,
            },
            'Successfully processed Formspree submission as incoming lead',
          )

          return reply.send({
            success: true,
            message: 'Incoming lead created successfully in Kommo',
            leadId,
            alreadyProcessed: false,
          })
        } catch (kommoError) {
          // Log the error but don't mark as sent since it failed
          fastify.log.error(kommoError, 'Failed to create incoming lead in Kommo')

          return reply.code(500).send({
            success: false,
            message: 'Failed to create incoming lead in Kommo',
            error: kommoError.message,
          })
        }
      } catch (error) {
        fastify.log.error(error, 'Unexpected error processing webhook')

        return reply.code(500).send({
          success: false,
          message: 'Internal server error',
          error: error.message,
        })
      }
    },
  )

  /**
   * GET /webhooks/health
   * Check service status and configuration
   */
  fastify.get(
    '/health',
    {
      schema: {
        description: 'Check webhook service health',
        tags: ['webhooks', 'health'],
        response: {
          200: {
            description: 'Health check response',
            type: 'object',
            properties: {
              status: { type: 'string' },
              environment: { type: 'string' },
              kommoConfigured: { type: 'boolean' },
              sentCount: { type: 'number' },
              uptime: { type: 'number' },
              timestamp: { type: 'string' },
            },
          },
          500: {
            description: 'Internal server error',
            type: 'object',
            properties: {
              status: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Check Kommo configuration
        let kommoConfigured = false
        try {
          kommoService.validateConfig()
          kommoConfigured = true
        } catch (error) {
          fastify.log.warn(error.message)
        }

        // Get sent registry stats
        const sentEntries = await sentRegistry.getAllSent()

        return reply.send({
          status: kommoConfigured ? 'ok' : 'unhealthy',
          environment: process.env.NODE_ENV || 'development',
          kommoConfigured,
          sentCount: sentEntries.length,
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        })
      } catch (error) {
        fastify.log.error(error, 'Error checking status')
        return reply.code(500).send({
          status: 'error',
          error: error.message,
        })
      }
    },
  )
}
