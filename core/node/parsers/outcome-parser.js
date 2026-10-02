/**
 * OutcomeParser — парсинг outcome строк в структурированный объект
 * 
 * Extracted from auto_sansa/playwright_task_executor.js (Story 2.2 / AUTO-CORE-2)
 * Implements CORE-REQ-01 from Story 1.5
 * 
 * Поддерживает 6 категорий исходов из Story 1.3:
 * - 1X2 (основной исход матча)
 * - Totals (общие тоталы матча)
 * - Individual Totals (IT1/IT2)
 * - Team Totals (T1/T2)
 * - Handicap (H1/H2)
 * - Period markets (P1/P2/1H/2H для всех типов выше)
 * 
 * @see docs/stories/1.3.story.md (outcome types catalog)
 * @see docs/stories/1.5.story.md (CORE-REQ-01)
 * @see docs/stories/2.2.story.md (extraction story)
 * @see docs/autobetting/outcome-types-catalog.md (full catalog with examples)
 */

class OutcomeParser {
  /**
   * Parse outcome string into structured object
   * 
   * Extracted from auto_sansa/playwright_task_executor.js (lines 455-560)
   * Logic is preserved AS IS for backward compatibility with production system.
   * 
   * @param {Object} task - Task object with outcome field
   * @param {string} task.outcome - Outcome string (e.g., "T> 2.5", "1", "H1 -1.5", "P1 IT1< 1.5")
   * @param {number} [task.period] - Optional period number (for recursive parsing)
   * @returns {Object} Parsed outcome object with fields:
   *   - marketHint: string ('1x2', 'totals', 'teamtotals', 'handicap', null)
   *   - line: number (for totals/handicap)
   *   - overUnder: string ('over', 'under')
   *   - teamIndex: number (1 or 2, for IT/Team Totals)
   *   - handicapTeam: number (1 or 2)
   *   - handicapLine: number
   *   - oneXtwo: string ('1', 'X', '2')
   *   - period: number | null
   *   - outcomePattern: string (fallback for unknown formats)
   * 
   * @example
   * // General totals
   * OutcomeParser.parse({ outcome: "T> 2.5" })
   * // => { marketHint: 'totals', line: 2.5, overUnder: 'over', period: null }
   * 
   * @example
   * // Individual Totals with period
   * OutcomeParser.parse({ outcome: "P1 IT1< 1.5" })
   * // => { marketHint: 'teamtotals', teamIndex: 1, line: 1.5, overUnder: 'under', period: 1 }
   * 
   * @example
   * // Handicap
   * OutcomeParser.parse({ outcome: "H1(-1.5)" })
   * // => { marketHint: 'handicap', handicapTeam: 1, handicapLine: -1.5, period: null }
   * 
   * @example
   * // 1X2 with period
   * OutcomeParser.parse({ outcome: "P2 1" })
   * // => { marketHint: '1x2', oneXtwo: '1', period: 2 }
   */
  static parse(task) {
    const outcome = task.outcome;
    
    // === PERIOD PARSING (recursive) ===
    // Period-specific markets (e.g., "P1 1", "P2 T> 8.5", "P3 T> 10.5", "1H Over 1.5")
    const periodMatch = outcome.match(/^(?:P([1-9])|Q([1-9])|S([1-9])|([12])H|(First Half|Second Half))\s+(.+)/i);
    if (periodMatch) {
      let period;
      if (periodMatch[1]) period = parseInt(periodMatch[1]);           // P1-P9
      else if (periodMatch[2]) period = parseInt(periodMatch[2]);      // Q1-Q9
      else if (periodMatch[3]) period = parseInt(periodMatch[3]);      // S1-S9
      else if (periodMatch[4]) period = parseInt(periodMatch[4]);      // 1H, 2H
      else period = /^second/i.test(periodMatch[5]) ? 2 : 1;          // First Half=1, Second Half=2
      const remainingOutcome = periodMatch[6].trim();
      
      // Recursively parse the remaining outcome with period context
      const parsed = OutcomeParser.parse({ ...task, outcome: remainingOutcome, period });
      if (parsed) {
        parsed.period = period;
        return parsed;
      }
    }

    // === PLAYER PROPS (MUST BE BEFORE TOTALS — "3PT>" would match as T>) ===
    // Format from analyzer: "PP <PlayerName> <Market></>< <Line>"
    // Examples: "PP kyle kuzma Points< 10.5", "PP jayson tatum Rebounds> 7.5"
    const ppMatch = outcome.match(/^PP\s+(.+?)\s+(Points|Rebounds|Assists|Steals|Blocks|Turnovers|3PT|Pts\+Rebs\+Asts|Fantasy)([><])\s*([\d.]+)$/i);
    if (ppMatch) {
      return {
        marketHint: 'playerprop',
        playerName: ppMatch[1].trim().toLowerCase(),
        market: ppMatch[2],
        overUnder: ppMatch[3] === '>' ? 'over' : 'under',
        line: parseFloat(ppMatch[4]),
        period: task.period || null
      };
    }

    // === 1X2 MARKET ===
    // Examples: "1", "X", "2"
    if (/^[1X2]$/.test(outcome)) {
      return {
        marketHint: '1x2',
        oneXtwo: outcome,
        period: task.period || null
      };
    }

    // === HANDICAP ===
    // ✅ FIX 2025-11-16: MUST BE BEFORE TOTALS!
    // Totals regex `/([0-9.]+)\s*([+\-])/` incorrectly captures "H1 -0.5" as Totals!
    // Examples: "H1 -1.5", "H2 +2.5", "H1(-1.5)", "Handicap 1 (-2.0)"
    const handicapMatch = outcome.match(/(?:H|Handicap)\s*([12])\s*\(?\s*([+\-]?[0-9.]+)\s*\)?/i);
    if (handicapMatch) {
      const handicapTeam = parseInt(handicapMatch[1]);
      const handicapLine = parseFloat(handicapMatch[2]);
      return {
        marketHint: 'handicap',
        handicapTeam,
        handicapLine,
        period: task.period || null
      };
    }

    // Legacy shorthand: "1 (-1.5)" / "2 (+1.5)".
    const bareHandicapMatch = outcome.match(/^([12])\s*\(\s*([+\-]?[0-9.]+)\s*\)$/);
    if (bareHandicapMatch) {
      return {
        marketHint: 'handicap',
        handicapTeam: parseInt(bareHandicapMatch[1]),
        handicapLine: parseFloat(bareHandicapMatch[2]),
        period: task.period || null
      };
    }

    // === TOTAL GOALS RANGE (must be before totals — "TGR 0-1" has "0-" matching totals regex) ===
    // Examples: "TGR 0-1", "TGR 2-3", "TGR 4-6"
    const tgrMatch = outcome.match(/^TGR\s+(\d+-\d+)$/i);
    if (tgrMatch) {
      return {
        marketHint: 'totalgoalsrange',
        selection: tgrMatch[1],
        period: task.period || null
      };
    }

    // === WINNER + TOTAL COMBO (must be before totals — "WTC Home & Over 2.5" matches totals) ===
    // Examples: "WTC Home & Over 2.5", "WTC Away & Under 2.5", "WTC Draw & Over 1.5"
    const wtcMatch = outcome.match(/^WTC\s+(Home|Away|Draw)\s*&\s*(Over|Under)\s+([0-9.]+)$/i);
    if (wtcMatch) {
      const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
      return {
        marketHint: 'winnertotalcombo',
        selection: `${cap(wtcMatch[1])} & ${cap(wtcMatch[2])} ${wtcMatch[3]}`,
        period: task.period || null
      };
    }

    // === BTTS + TOTAL COMBO (must be before totals — "BTC No & Over 2.5" matches totals) ===
    // Examples: "BTC Yes & Over 2.5", "BTC No & Under 2.5"
    const btcMatch = outcome.match(/^BTC\s+(Yes|No)\s*&\s*(Over|Under)\s+([0-9.]+)$/i);
    if (btcMatch) {
      const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
      return {
        marketHint: 'bttsTotalCombo',
        selection: `${cap(btcMatch[1])} & ${cap(btcMatch[2])} ${btcMatch[3]}`,
        period: task.period || null
      };
    }

    // === BTTS + WINNER COMBO ===
    // Examples: "BWC Yes & Home", "BWC Yes & Away", "BWC Yes & Draw"
    const bwcMatch = outcome.match(/^BWC\s+(Yes|No)\s*&\s*(Home|Away|Draw)$/i);
    if (bwcMatch) {
      const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
      return {
        marketHint: 'bttsWinnerCombo',
        selection: `${cap(bwcMatch[1])} & ${cap(bwcMatch[2])}`,
        period: task.period || null
      };
    }

    // === CORRECT SCORE ===
    // Examples: "CS 1:0", "CS 0:0", "CS 2-1"
    const csMatch = outcome.match(/^CS\s*(\d+)[:\-](\d+)$/);
    if (csMatch) {
      const homeScore = parseInt(csMatch[1]);
      const awayScore = parseInt(csMatch[2]);
      return {
        marketHint: 'correctscore',
        homeScore,
        awayScore,
        homeGoals: homeScore,
        awayGoals: awayScore,
        selection: `${csMatch[1]}:${csMatch[2]}`,
        period: task.period || null
      };
    }

    // === TOTALS (GENERAL) ===
    // Examples: "Over 2.5", "Under 3.5", "2.5+", "1.5-", "T> 30.5", "T< 1.5"
    const totalsMatch = outcome.match(/T\s*([><])\s*([0-9.]+)|(over|under|više|manje)\s*([0-9.]+)|([0-9.]+)\s*([+\-])/i);
    if (totalsMatch) {
      let overUnder, line;
      if (totalsMatch[1]) {
        // "T> 30.5" или "T< 1.5"
        overUnder = totalsMatch[1] === '>' ? 'over' : 'under';
        line = parseFloat(totalsMatch[2]);
      } else if (totalsMatch[3]) {
        // "Over 2.5" или "Under 3.5"
        overUnder = /over|više/i.test(totalsMatch[3]) ? 'over' : 'under';
        line = parseFloat(totalsMatch[4]);
      } else {
        // "2.5+" или "1.5-"
        overUnder = totalsMatch[6] === '+' ? 'over' : 'under';
        line = parseFloat(totalsMatch[5]);
      }
      return {
        marketHint: 'totals',
        line,
        overUnder,
        period: task.period || null
      };
    }

    // === INDIVIDUAL TOTALS (IT) ===
    // Examples: "IT1< 1.5", "IT2> 0.5", "IT1< 0.5", "IT2> 2.5"
    // CRITICAL: IT = Individual Total (индивидуальный тотал команды)
    const individualTotalsMatch = outcome.match(/IT\s*([12])\s*([><])\s*([0-9.]+)/i);
    if (individualTotalsMatch) {
      const teamIndex = parseInt(individualTotalsMatch[1]);
      const overUnder = individualTotalsMatch[2] === '>' ? 'over' : 'under';
      const line = parseFloat(individualTotalsMatch[3]);
      
      return {
        marketHint: 'teamtotals',
        teamIndex,
        line,
        overUnder,
        period: task.period || null
      };
    }
    
    // === TEAM TOTALS (T1/T2) ===
    // Examples: "T1 Over 1.5", "Team 1 Under 0.5", "T1 1.5+", "T2 0.5-"
    const teamTotalsMatch = outcome.match(/(?:T|Team)\s*([12])\s*(?:over|under|više|manje)?\s*([0-9.]+)\s*([+\-])?|(?:T|Team)\s*([12])\s*([0-9.]+)\s*([+\-])/i);
    if (teamTotalsMatch) {
      const teamIndex = parseInt(teamTotalsMatch[1] || teamTotalsMatch[4]);
      let line, overUnder;
      
      if (teamTotalsMatch[3] || teamTotalsMatch[6]) {
        const sign = teamTotalsMatch[3] || teamTotalsMatch[6];
        overUnder = sign === '+' ? 'over' : 'under';
        line = parseFloat(teamTotalsMatch[2] || teamTotalsMatch[5]);
      } else {
        const text = outcome.toLowerCase();
        overUnder = /over|више/.test(text) ? 'over' : 'under';
        line = parseFloat(teamTotalsMatch[2]);
      }
      
      return {
        marketHint: 'teamtotals',
        teamIndex,
        line,
        overUnder,
        period: task.period || null
      };
    }

    // === GAME WINNER (1G/2G) ===
    // Examples: "1G 3.0", "2G 5.5", "P1 1G 3.0"
    // Format: Team (1 or 2) + G + Game number
    const gameWinnerMatch = outcome.match(/([12])G\s*([0-9.]+)/i);
    if (gameWinnerMatch) {
      const team = parseInt(gameWinnerMatch[1]);
      const line = parseFloat(gameWinnerMatch[2]);
      
      return {
        marketHint: 'game_winner',
        team,
        line,
        period: task.period || null
      };
    }

    // === DOUBLE CHANCE ===
    // Examples: "DC 1X", "DC X2", "DC 12"
    const dcMatch = outcome.match(/^DC\s*([1X2]{2})$/i);
    if (dcMatch) {
      return {
        marketHint: 'doublechance',
        selection: dcMatch[1].toUpperCase(),
        period: task.period || null
      };
    }

    // === DRAW NO BET ===
    // Examples: "DNB 1", "DNB 2"
    const dnbMatch = outcome.match(/^DNB\s*([12])$/i);
    if (dnbMatch) {
      return {
        marketHint: 'drawnobet',
        selection: dnbMatch[1],
        period: task.period || null
      };
    }

    // === BOTH TEAMS TO SCORE ===
    // Examples: "BTTS Yes", "BTTS No"
    const bttsMatch = outcome.match(/^BTTS\s*(Yes|No)$/i);
    if (bttsMatch) {
      return {
        marketHint: 'btts',
        selection: bttsMatch[1].toLowerCase(),
        period: task.period || null
      };
    }

    // === HOME WIN TO NIL ===
    // Examples: "HWN Yes"
    const hwnMatch = outcome.match(/^HWN\s*(Yes|No)$/i);
    if (hwnMatch) {
      return {
        marketHint: 'homewintonil',
        selection: hwnMatch[1].toLowerCase(),
        period: task.period || null
      };
    }

    // === AWAY WIN TO NIL ===
    // Examples: "AWN Yes"
    const awnMatch = outcome.match(/^AWN\s*(Yes|No)$/i);
    if (awnMatch) {
      return {
        marketHint: 'awaywintonil',
        selection: awnMatch[1].toLowerCase(),
        period: task.period || null
      };
    }

    // === ODD/EVEN ===
    // Examples: "OE Odd", "OE Even"
    const oeMatch = outcome.match(/^OE\s*(Odd|Even)$/i);
    if (oeMatch) {
      return {
        marketHint: 'oddeven',
        selection: oeMatch[1].toLowerCase(),
        period: task.period || null
      };
    }

    // === HALF TIME / FULL TIME ===
    // Examples: "HT/FT 1/X", "HT/FT X/2", "HT/FT 1/1"
    const htftMatch = outcome.match(/^HT\/FT\s+([1X2])\/([1X2])$/i);
    if (htftMatch) {
      return {
        marketHint: 'htft',
        htSelection: htftMatch[1].toUpperCase(),
        ftSelection: htftMatch[2].toUpperCase(),
        period: task.period || null
      };
    }

    // === HOME EXACT GOALS ===
    // Examples: "HEG 0", "HEG 1", "HEG 3+"
    const hegMatch = outcome.match(/^HEG\s*(\d+\+?)$/i);
    if (hegMatch) {
      return {
        marketHint: 'homeexactgoals',
        selection: hegMatch[1],
        period: task.period || null
      };
    }

    // === AWAY EXACT GOALS ===
    // Examples: "AEG 0", "AEG 1", "AEG 3+"
    const aegMatch = outcome.match(/^AEG\s*(\d+\+?)$/i);
    if (aegMatch) {
      return {
        marketHint: 'awayexactgoals',
        selection: aegMatch[1],
        period: task.period || null
      };
    }

    // === CORNERS TOTAL ===
    // Examples: "CT> 9.5", "CT< 8.5"
    const ctMatch = outcome.match(/^CT\s*([><])\s*([0-9.]+)$/i);
    if (ctMatch) {
      return {
        marketHint: 'cornerstotal',
        overUnder: ctMatch[1] === '>' ? 'over' : 'under',
        line: parseFloat(ctMatch[2]),
        period: task.period || null
      };
    }

    // === CORNERS HANDICAP ===
    // Examples: "CH1 -1.5", "CH2 0.5"
    const chMatch = outcome.match(/^CH\s*([12])\s*([+\-]?[0-9.]+)$/i);
    if (chMatch) {
      return {
        marketHint: 'cornershandicap',
        team: parseInt(chMatch[1]),
        line: parseFloat(chMatch[2]),
        period: task.period || null
      };
    }

    // === CORNERS INDIVIDUAL TOTALS ===
    // Examples: "CIT1> 4.5", "CIT2< 3.5"
    const citMatch = outcome.match(/^CIT\s*([12])\s*([><])\s*([0-9.]+)$/i);
    if (citMatch) {
      return {
        marketHint: 'cornersteamtotal',
        teamIndex: parseInt(citMatch[1]),
        overUnder: citMatch[2] === '>' ? 'over' : 'under',
        line: parseFloat(citMatch[3]),
        period: task.period || null
      };
    }

    // === EXACT TOTAL GOALS ===
    // Examples: "ETG 3", "ETG 3+"
    const etgMatch = outcome.match(/^ETG\s*(\d+\+?)$/i);
    if (etgMatch) {
      return {
        marketHint: 'exacttotalgoals',
        selection: etgMatch[1],
        period: task.period || null
      };
    }

    // === FIRST TO SCORE ===
    // Examples: "FTS Home", "FTS Away", "FTS Neither"
    const ftsMatch = outcome.match(/^FTS\s*(Home|Away|Neither)$/i);
    if (ftsMatch) {
      return {
        marketHint: 'firsttoscore',
        selection: ftsMatch[1].toLowerCase(),
        period: task.period || null
      };
    }

    // === HOME/AWAY TO SCORE ===
    // Examples: "HTS Yes", "HTS No", "ATS Yes", "ATS No"
    const hatsMatch = outcome.match(/^(H|A)TS\s*(Yes|No)$/i);
    if (hatsMatch) {
      return {
        marketHint: hatsMatch[1].toUpperCase() === 'H' ? 'hometoscore' : 'awaytoscore',
        selection: hatsMatch[2].toLowerCase(),
        period: task.period || null
      };
    }

    // === EITHER TEAM TO SCORE ===
    // Examples: "ETS Yes", "ETS No"
    const etsMatch = outcome.match(/^ETS\s*(Yes|No)$/i);
    if (etsMatch) {
      return {
        marketHint: 'eithertoscore',
        selection: etsMatch[1].toLowerCase(),
        period: task.period || null
      };
    }

    // === 3-WAY HANDICAP ===
    // Examples: "3WH -1 1", "3WH -1 X", "3WH -1 2"
    const thwMatch = outcome.match(/^3WH\s*([+\-]?[0-9.]+)\s*([1X2])$/i);
    if (thwMatch) {
      return {
        marketHint: '3wayhandicap',
        line: parseFloat(thwMatch[1]),
          selection: thwMatch[2].toUpperCase(),
        period: task.period || null
      };
    }

    // === WINNING MARGIN ===
    // Examples: "WM Home By 1", "WM NoGoal"
    const wmMatch = outcome.match(/^WM\s+(.+)$/i);
    if (wmMatch) {
      return {
        marketHint: 'winningmargin',
        selection: wmMatch[1].trim(),
        period: task.period || null
      };
    }

    // === FALLBACK (UNKNOWN FORMAT) ===
    // Return generic outcome pattern
    console.warn('⚠️  Unable to parse outcome, using generic pattern:', outcome);
    return {
      outcomePattern: outcome,
      marketHint: null
    };
  }
}

module.exports = { OutcomeParser };
