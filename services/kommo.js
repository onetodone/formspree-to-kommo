const { config } = require('../config')

/**
 * Kommo CRM API integration service
 */
class KommoService {
  constructor(logger) {
    this.logger = logger
    this.config = config.kommo
    this.kommoUrl = this.config.kommoUrl
    this.apiUrl = this.kommoUrl ? `${this.kommoUrl}/api/v4` : null
    this.oauthUrl = this.kommoUrl ? `${this.kommoUrl}/oauth2/access_token` : null
    this.accessToken = this.config.accessToken
    this.refreshToken = this.config.refreshToken
    this.clientId = this.config.clientId
    this.clientSecret = this.config.clientSecret
    this.redirectUri = this.config.redirectUri

    // Default values for required fields
    this.defaultPipelineId = this.config.defaultPipelineId
  }
  /**
   * Validate configuration
   */
  validateConfig() {
    const required = ['KOMMO_URL', 'KOMMO_ACCESS_TOKEN', 'KOMMO_DEFAULT_PIPELINE_ID']
    const missing = required.filter((key) => !process.env[key])

    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
    }

    // Warn about missing default values
    if (!this.defaultPipelineId) {
      this.logger?.fastifyLogger?.warn(
        'Missing default field values. Please set KOMMO_DEFAULT_PIPELINE_ID in your environment variables.',
      )
    }
  }

  /**
   * Get headers for API requests
   */
  getHeaders() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'FormspreeToKommo/1.0',
    }
  }

  /**
   * Refresh access token if needed
   */
  async refreshAccessToken() {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      throw new Error('Missing refresh token or client credentials')
    }

    try {
      const response = await fetch(this.oauthUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          redirect_uri: this.redirectUri,
        }),
      })

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`)
      }

      const tokenData = await response.json()
      this.accessToken = tokenData.access_token

      if (tokenData.refresh_token) {
        this.refreshToken = tokenData.refresh_token
      }

      this.logger?.logKommoResponse(tokenData, true, 'token refresh')

      // Note: In production, you'd want to save the new tokens securely
      this.logger?.fastifyLogger?.warn('New access token received. Update your .env file with the new token.')

      return tokenData
    } catch (error) {
      this.logger?.logKommoResponse({ error: error.message }, false, 'token refresh')
      throw error
    }
  }

  /**
   * Extract field value by trying multiple possible field names
   * @param {Object} submission - Form submission object
   * @param {Array} fieldNames - Array of possible field names to try
   * @returns {string|null} - Found value or null
   */
  extractFieldValue(submission, fieldNames) {
    for (const fieldName of fieldNames) {
      if (submission[fieldName] !== undefined && submission[fieldName] !== null && submission[fieldName] !== '') {
        return submission[fieldName]
      }
    }
    return null
  }

  /**
   * Get all additional fields that aren't standard contact fields
   * @param {Object} submission - Form submission object
   * @returns {Array} - Array of {key, value} objects for additional fields
   */
  getAdditionalFields(submission) {
    const standardFields = [
      'email',
      'Email',
      'E-mail',
      'EMAIL',
      'e-mail',
      'name',
      'Name',
      'Full Name',
      'First Name',
      'firstName',
      'full_name',
      'first_name',
      'fullName',
      'Last Name',
      'lastName',
      'last_name',
      'phone',
      'Phone',
      'Phone Number',
      'tel',
      'telephone',
      'mobile',
      'phone_number',
      'phoneNumber',
      'message',
      'Message',
      'comment',
      'Comment',
      'comments',
      'description',
      'Description',
      'text',
      'body',
      'from',
      'sitelang',
      '_date', // Formspree specific fields
    ]

    const additionalFields = []
    Object.keys(submission).forEach((key) => {
      if (!standardFields.includes(key) && submission[key] !== null && submission[key] !== '') {
        additionalFields.push({
          key: key,
          value: submission[key],
        })
      }
    })

    return additionalFields
  }

  /**
   * Transform Formspree payload to Kommo incoming lead format
   * @param {Object} formspreePayload - Formspree webhook payload
   */
  async transformToKommoIncomingLead(formspreePayload) {
    const { submission } = formspreePayload

    // Extract common fields with more flexible field matching
    const email = this.extractFieldValue(submission, ['email', 'Email', 'E-mail', 'EMAIL', 'e-mail'])
    const name = this.extractFieldValue(submission, [
      'name',
      'Name',
      'Full Name',
      'First Name',
      'firstName',
      'full_name',
      'first_name',
      'fullName',
      'Last Name',
      'lastName',
      'last_name',
    ])
    const phone = this.extractFieldValue(submission, [
      'phone',
      'Phone',
      'Phone Number',
      'tel',
      'telephone',
      'mobile',
      'phone_number',
      'phoneNumber',
    ])
    const message = this.extractFieldValue(submission, [
      'message',
      'Message',
      'comment',
      'Comment',
      'comments',
      'description',
      'Description',
      'text',
      'body',
    ])

    // Extract form source for better lead naming
    const formSource = submission.from || 'Unrecognized Form'
    const formId = formspreePayload.form || 'unknown'
    const siteLang = submission.sitelang || '-'
    const timestamp = Math.floor(Date.now() / 1000)

    // Create comprehensive message for the lead
    let leadMessage = ''
    if (message) {
      leadMessage += `Message: ${message}\n\n`
    }

    // Get all additional form fields that aren't standard contact info
    const additionalFields = this.getAdditionalFields(submission)
    if (additionalFields.length > 0) {
      leadMessage += '== Additional Form Data ==\n'
      additionalFields.forEach((field) => {
        const fieldName = field.key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase())
        leadMessage += `${fieldName}: ${field.value}\n`
      })
    }

    // Add form metadata
    leadMessage += `\n== Form Information ==\n`
    leadMessage += `Form Source: ${formSource}\n`
    leadMessage += `Site Language: ${siteLang}\n`
    leadMessage += `Formspree Form ID: ${formId}\n`
    leadMessage += `Submitted To Formspree: ${submission._date || timestamp}\n`

    // Build the incoming lead according to Kommo API requirements
    const { v4: uuidv4 } = require('uuid')
    const requestID = uuidv4() // Random request ID for tracking
    const sourceUid = `formspree_${formId}_${timestamp}`
    const sourceName = formSource + ' (Formspree Integration)'

    const incomingLead = {
      request_id: requestID,
      source_uid: sourceUid,
      source_name: sourceName,
      pipeline_id: parseInt(this.defaultPipelineId, 10),
      created_at: timestamp,
      metadata: {
        form_id: formId,
        form_name: formSource,
        form_page: formSource + ' SIDWebsite',
        form_sent_at: timestamp, // Required field that was missing
        // Note: Other fields like lead_name, contact_name, etc. are not expected by the API
      },
      _embedded: {
        leads: [
          {
            pipeline_id: this.defaultPipelineId,
            created_by: 0, // Assuming system user
            created_at: timestamp,
            responsible_user_id: 0,
            tags: [], // No tags by default, can be added later
          },
        ],
        contacts: [
          {
            name: name || email || 'Unknown Contact',
            created_by: 0, // Assuming system user
            created_at: timestamp,
            custom_fields_values: [
              {
                field_code: 'EMAIL',
                values: [
                  {
                    enum_code: 'WORK', // Default enum for email
                    value: email || '',
                  },
                ],
              },
              {
                field_code: 'PHONE',
                values: [
                  {
                    enum_code: 'WORK', // Default enum for phone
                    value: phone || '',
                  },
                ],
              },
            ],
          },
        ],
      },
    }

    // Return as array as required by the API
    return { leadData: [incomingLead], leadMessage }
  }

  /**
   * Create an incoming lead in Kommo
   * @param {Array} incomingLeadData - Array of incoming lead data in Kommo format
   */
  async createIncomingLead(incomingLeadData) {
    this.validateConfig()

    try {
      const response = await fetch(`${this.apiUrl}/leads/unsorted/forms`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(incomingLeadData), // Send as array
      })

      const responseData = await response.json()

      if (!response.ok) {
        // Try to refresh token if it's an auth error
        if (response.status === 401 && this.refreshToken) {
          this.logger?.fastifyLogger?.info('Access token expired, attempting refresh')
          await this.refreshAccessToken()

          // Retry the request with new token
          const retryResponse = await fetch(`${this.apiUrl}/leads/unsorted/forms`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(incomingLeadData),
          })

          const retryData = await retryResponse.json()

          if (!retryResponse.ok) {
            throw new Error(
              `Kommo API error after token refresh: ${retryResponse.status} - ${JSON.stringify(retryData)}`,
            )
          }

          this.logger?.logKommoResponse(retryData, true, 'incoming lead creation (after token refresh)')
          return retryData
        }

        throw new Error(`Kommo API error: ${response.status} - ${JSON.stringify(responseData)}`)
      }

      this.logger?.logKommoResponse(responseData, true, 'incoming lead creation')
      return responseData
    } catch (error) {
      this.logger?.logKommoResponse({ error: error.message }, false, 'incoming lead creation')
      throw error
    }
  }

  /**
   * Create a lead from Formspree payload (creates incoming lead)
   * @param {Object} formspreePayload - Original Formspree webhook payload
   */
  async createLeadFromFormspree(formspreePayload) {
    const { leadData, leadMessage } = await this.transformToKommoIncomingLead(formspreePayload)
    const kommoResponse = await this.createIncomingLead(leadData)
    return { kommoResponse, leadMessage }
  }

  async addNoteToLead(leadId, message) {
    if (!leadId || !message) return

    try {
      const response = await fetch(`${this.apiUrl}/leads/notes`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify([
          {
            note_type: 'common',
            entity_id: leadId,
            entity_type: 'leads',
            params: {
              text: message,
            },
          },
        ]),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(`Failed to add note: ${response.status} - ${JSON.stringify(result)}`)
      }

      this.logger?.logKommoResponse(result, true, 'add lead note')
      return result
    } catch (error) {
      this.logger?.logKommoResponse({ error: error.message }, false, 'add lead note')
      throw error
    }
  }
}

module.exports = KommoService
