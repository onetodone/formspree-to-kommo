const fs = require('fs/promises')
const path = require('path')

/**
 * Simple JSON-based database for tracking sent leads
 */
class SentRegistry {
  constructor() {
    this.dbPath = path.join(__dirname, '..', 'db', 'sent.json')
    this.cache = null
  }

  /**
   * Load the sent registry from file
   */
  async load() {
    try {
      const data = await fs.readFile(this.dbPath, 'utf8')

      // Check if file is empty or only contains whitespace
      if (!data || data.trim() === '') {
        console.warn('Registry file is empty, initializing with default data')
        this.cache = { sent: [], lastUpdated: new Date().toISOString() }
        await this.save()
        return this.cache
      }

      this.cache = JSON.parse(data)

      // Validate the structure
      if (!this.cache.sent || !Array.isArray(this.cache.sent)) {
        console.warn('Registry file has invalid structure, resetting')
        this.cache = { sent: [], lastUpdated: new Date().toISOString() }
        await this.save()
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, create empty registry
        console.log('Registry file does not exist, creating new one')
        this.cache = { sent: [], lastUpdated: new Date().toISOString() }
        await this.save()
      } else if (error instanceof SyntaxError) {
        // JSON parsing failed, backup corrupted file and create new one
        console.error('Registry file is corrupted, backing up and creating new one')
        try {
          const backupPath = `${this.dbPath}.backup.${Date.now()}`
          await fs.copyFile(this.dbPath, backupPath)
          console.log(`Corrupted registry backed up to: ${backupPath}`)
        } catch (backupError) {
          console.error('Failed to backup corrupted registry:', backupError.message)
        }

        this.cache = { sent: [], lastUpdated: new Date().toISOString() }
        await this.save()
      } else {
        throw error
      }
    }
    return this.cache
  }

  /**
   * Ensure the registry is loaded
   */
  async ensureLoaded() {
    if (!this.cache) {
      await this.load()
    }
  }

  /**
   * Save the registry to file
   */
  async save() {
    try {
      const dbDir = path.dirname(this.dbPath)
      await fs.mkdir(dbDir, { recursive: true })

      this.cache.lastUpdated = new Date().toISOString()
      await fs.writeFile(this.dbPath, JSON.stringify(this.cache, null, 2))
    } catch (error) {
      throw new Error(`Failed to save sent registry: ${error.message}`, { cause: error })
    }
  }

  /**
   * Check if an email has already been sent
   * @param {string} email - Email to check
   * @param {string} formUniqueId - required for form submissions to avoid duplicates
   */
  async isAlreadySent(email, formUniqueId) {
    await this.ensureLoaded()

    const identifier = `${email}:${formUniqueId}`
    return this.cache.sent.some((entry) => entry.identifier === identifier)
  }

  /**
   * Mark an email as sent
   * @param {string} email - Email that was sent
   * @param {string} formUniqueId - required for form submissions to avoid duplicates
   * @param {Object} metadata - Additional metadata about the sent lead
   */
  async markAsSent(email, formUniqueId, metadata = {}) {
    await this.ensureLoaded()

    const identifier = `${email}:${formUniqueId}`
    const entry = {
      identifier,
      email,
      formUniqueId,
      timestamp: new Date().toISOString(),
      metadata,
    }

    this.cache.sent.push(entry)
    await this.save()
  }

  /**
   * Get all sent entries
   */
  async getAllSent() {
    await this.ensureLoaded()
    return this.cache.sent
  }
}

module.exports = SentRegistry
