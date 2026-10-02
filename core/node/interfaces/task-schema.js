/**
 * Task Schema Definition
 * Implements EXECUTOR-REQ-02 from Story 1.5
 * 
 * All tasks must have bookmakerId field
 * 
 * @see docs/stories/1.5.story.md (EXECUTOR-REQ-02)
 */

/**
 * @typedef {Object} Task
 * @property {number} id - Unique task ID (timestamp)
 * @property {string} bookmakerId - Target bookmaker identifier (e.g., 'sansabet', 'pinnacle')
 * @property {string} home - Home team name
 * @property {string} away - Away team name
 * @property {string} outcome - Outcome string (e.g., 'T> 2.5', '1', 'H1 -1.5')
 * @property {number} stake - Stake amount
 * @property {number} minOdds - Minimum acceptable odds
 * @property {number} maxOdds - Maximum acceptable odds
 * @property {string} source - Task source ('analyzer', 'telegram', 'manual')
 * @property {number} timestamp - Task creation timestamp
 * @property {string} [sport] - Sport type (optional, for filtering)
 * @property {number} [expectedROI] - Expected ROI (optional, from Analyzer)
 * @property {Object} [pairFull] - Full pair data from Analyzer (optional)
 */

/**
 * Validate task object
 * @param {Object} task - Task object to validate
 * @returns {boolean} true if valid
 * @throws {Error} if task is missing required fields
 */
function validateTask(task) {
  const requiredFields = ['id', 'bookmakerId', 'home', 'away', 'outcome', 'stake', 'minOdds', 'maxOdds', 'source', 'timestamp'];
  for (const field of requiredFields) {
    if (!(field in task)) {
      throw new Error(`Task missing required field: ${field}`);
    }
  }
  return true;
}

module.exports = { validateTask };
