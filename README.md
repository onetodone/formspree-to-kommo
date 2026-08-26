# Formspree to Kommo CRM Integration

A Fastify-based webhook proxy service that converts Formspree form submissions into Kommo CRM incoming leads, with logging, duplicate prevention, and webhook security checks.

## Features

- 🔗 **Webhook Integration**: Receives Formspree webhooks and creates Kommo incoming leads
- 📝 **Note Attachment**: Full submission content (including any extra form fields) is attached to the created lead as a note
- 🚫 **Duplicate Prevention**: Tracks processed submissions by email + form + source + submission date
- 🔄 **Token Management**: Automatic OAuth access-token refresh for the Kommo API
- 📊 **Data Persistence**: Stores every incoming payload and maintains a registry of processed submissions
- 🔐 **Webhook Security**: Optional HMAC signature validation, replay-timestamp validation, and source-IP allowlisting
- 🔧 **Health Endpoint**: Reports Kommo configuration status and registry size

## Architecture

```
├── app.js                    # Fastify bootstrap, security plugins, redirects
├── config/
│   └── index.js              # Environment variable configuration
├── plugins/
│   └── sensible.js           # @fastify/sensible
├── routes/
│   ├── root.js                # GET /
│   └── webhooks/
│       └── index.js          # Webhook endpoints
├── services/
│   └── kommo.js              # Kommo API integration (leads, notes, OAuth refresh)
├── utils/
│   ├── logger.js             # Request/response logging
│   ├── registry.js           # Duplicate-submission tracking
│   └── webhook-validator.js  # Signature/timestamp/IP/payload validation
├── logs/                     # Timestamped request logs
└── db/
    ├── payload/               # Stored raw Formspree payloads
    └── sent.json              # Duplicate-prevention registry
```

## Quick Start

### 1. Installation

```bash
npm install
```

### 2. Environment Configuration

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Key variables:

```env
# Server
APP_DOMAIN=localhost:3000
APP_BASE_URL=http://localhost:3000

# Kommo API
KOMMO_URL=https://[YOUR_SUBDOMAIN].kommo.com
KOMMO_CLIENT_ID=[YOUR_CLIENT_ID]
KOMMO_CLIENT_SECRET=[YOUR_CLIENT_SECRET]
KOMMO_REDIRECT_URI=http://localhost:3000/oauth/callback
KOMMO_DEFAULT_PIPELINE_ID=[0000000]
```

#### Getting Kommo API Credentials

**Step 1: Create Integration in Kommo**

1. Log into your Kommo account
2. Go to Settings → Integrations → Create Private Integration
3. Set the redirect URI (`https://yourdomain.com/oauth/callback`, or `http://localhost:3000/oauth/callback` for testing)

**Step 2: Get Client Credentials**

Note down the `client_id` and `client_secret` shown after creating the integration.

**Step 3: Get Authorization Code**

Navigate to:

```
https://yoursubdomain.kommo.com/oauth?client_id=YOUR_CLIENT_ID&state=random_string&mode=post_message
```

Authorize the application and copy the authorization code from the response.

**Step 4: Exchange Code for Tokens**

```bash
curl -X POST https://yoursubdomain.kommo.com/oauth2/access_token \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "your_client_id",
    "client_secret": "your_client_secret",
    "grant_type": "authorization_code",
    "code": "your_authorization_code",
    "redirect_uri": "https://yourdomain.com/oauth/callback"
  }'
```

The response contains `access_token` and `refresh_token` — put both in `.env` as `KOMMO_ACCESS_TOKEN` and `KOMMO_REFRESH_TOKEN`.

> The service automatically refreshes the access token using the refresh token when a Kommo API call returns 401.

### 3. Start the Service

```bash
npm run dev    # development, with hot reload
npm start      # production
```

The service listens at `http://localhost:3000` by default.

## API Endpoints

### Webhook Endpoint

```http
POST /webhooks/formspree
```

Receives a Formspree webhook payload (`{ form, submission, keys }`), transforms it into a Kommo incoming lead, attaches the full submission as a note, and records it in the duplicate-prevention registry.

**Response**:

- `200 OK` — lead created (or submission already processed, `alreadyProcessed: true`)
- `400 Bad Request` — invalid payload / no email found
- `500 Internal Server Error` — processing or Kommo API error

### Health Endpoint

```http
GET /webhooks/health
```

Returns Kommo configuration status and the number of registry entries:

```json
{
  "status": "ok",
  "environment": "production",
  "kommoConfigured": true,
  "sentCount": 42,
  "uptime": 1234.5,
  "timestamp": "2026-08-26T10:30:00.000Z"
}
```

## Data Flow

1. **Webhook Reception**: Formspree sends a webhook to `/webhooks/formspree`
2. **Logging**: Request and payload are logged to `logs/` and `db/payload/`
3. **Validation**: In production, signature/timestamp/IP/payload checks run (see Security below)
4. **Duplicate Check**: Registry (`db/sent.json`) is checked using email + form + source + submission date
5. **Transformation**: Formspree submission is transformed into a Kommo incoming lead
6. **API Call**: Lead is created in Kommo; the full submission is attached to it as a note
7. **Registry Update**: Successful submission is recorded to prevent reprocessing
8. **Response**: Result is returned to Formspree

## Configuration

### Environment Variables

| Variable                      | Description                                    | Required |
| ----------------------------- | ---------------------------------------------- | -------- |
| `KOMMO_URL`                   | Your Kommo account URL                         | Yes      |
| `KOMMO_CLIENT_ID`             | OAuth client ID from Kommo                     | Yes      |
| `KOMMO_CLIENT_SECRET`         | OAuth client secret from Kommo                 | Yes      |
| `KOMMO_REDIRECT_URI`          | OAuth redirect URI                             | Yes      |
| `KOMMO_ACCESS_TOKEN`          | Current access token                           | Yes      |
| `KOMMO_REFRESH_TOKEN`         | Refresh token for automatic renewal            | Yes      |
| `KOMMO_DEFAULT_PIPELINE_ID`   | Pipeline used for created leads                | Yes      |
| `WEBHOOK_SECRET`              | HMAC secret for signature validation           | No       |
| `STRICT_SIGNATURE_VALIDATION` | Reject requests with missing/invalid signature | No       |
| `STRICT_IP_VALIDATION`        | Reject requests from unrecognized source IPs   | No       |
| `CORS_ORIGINS`                | Allowed CORS origins (comma-separated)         | No       |
| `RATE_LIMIT_MAX`              | Max requests per window (production only)      | No       |
| `RATE_LIMIT_WINDOW`           | Rate limit window                              | No       |
| `LOG_LEVEL`                   | Fastify logger level                           | No       |

## Security

Webhook validation (`utils/webhook-validator.js`) runs whenever `NODE_ENV=production`:

- **Signature validation**: if `WEBHOOK_SECRET` is set and `STRICT_SIGNATURE_VALIDATION=true`, requests must carry a valid `X-Formspree-Signature` / `X-Hub-Signature-256` HMAC-SHA256 header, verified against the raw request body. Without strict mode, mismatches are only logged.
- **Timestamp validation**: if an `X-Formspree-Timestamp` header is present, it must be within 5 minutes of the current time (replay protection).
- **Source IP validation**: if `STRICT_IP_VALIDATION=true`, requests must originate from Formspree/AWS IP ranges; otherwise the source IP is only logged.
- **Payload validation**: submission must be an object containing a usable email field, must not trip the Formspree honeypot (`_gotcha`), and must be under 50 KB.

Rate limiting, Helmet, and CORS (restricted to Formspree/submit-form origins) are enabled automatically when `NODE_ENV=production`.

## Data Storage

### Logging Structure

```
logs/
├── 2026-08-26/
│   ├── 10-30-15.json
│   └── 10-35-22.json
```

### Payload Storage

```
db/payload/
├── user@example.com_2026-08-26T10-30-15-000Z.json
```

### Registry (`db/sent.json`)

```json
{
  "sent": [
    {
      "identifier": "user@example.com:contact-website-form-2026-08-26T10:30:15.000Z",
      "email": "user@example.com",
      "formUniqueId": "contact-website-form-2026-08-26T10:30:15.000Z",
      "timestamp": "2026-08-26T10:30:15.000Z",
      "metadata": { "leadId": 12345, "formspreeForm": "contact" }
    }
  ],
  "lastUpdated": "2026-08-26T10:30:15.000Z"
}
```

## Production Deployment

### Security Checklist

- [ ] Never commit `.env` to version control
- [ ] Serve over HTTPS only
- [ ] Set `NODE_ENV=production` to enable rate limiting, Helmet, CORS restrictions, and webhook validation
- [ ] Set `WEBHOOK_SECRET` and enable `STRICT_SIGNATURE_VALIDATION` if Formspree signs your webhooks
- [ ] Rotate Kommo OAuth tokens periodically

### Monitoring

- Poll `GET /webhooks/health` for Kommo connectivity and registry size
- Watch `logs/` growth and `db/payload/` disk usage; both grow unbounded (no built-in cleanup in this version)

## Troubleshooting

**Webhook not receiving requests**

- Verify the Formspree webhook URL points to `/webhooks/formspree`
- Check firewall/reverse-proxy configuration and that the service is listening on the expected port

**Kommo API errors**

- Verify `KOMMO_ACCESS_TOKEN` / `KOMMO_REFRESH_TOKEN` are valid
- Confirm `KOMMO_DEFAULT_PIPELINE_ID` is set and the integration has permission to create leads

**Duplicate detection not working as expected**

- Check `db/sent.json` is writable
- Recall the dedup key includes the Formspree submission date, so identical resubmissions on a new date are treated as new leads by design

**Webhook validation rejecting valid requests**

- Confirm `WEBHOOK_SECRET` matches what Formspree signs with, and that the signature header name matches (`X-Formspree-Signature` or `X-Hub-Signature-256`)
- Signature validation only runs when `NODE_ENV=production`

## License

ISC
