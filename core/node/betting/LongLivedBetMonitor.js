/**
 * LongLivedBetMonitor - мониторинг долгоживущих ставок
 * 
 * Отправляет уведомления в Telegram (чат 15+) когда ставка с ROI >= 15%
 * продержалась определённое время:
 * - LIVE: 7 секунд
 * - PREMATCH: 60 секунд
 * 
 * Работает только для указанных букмекеров: Lobbet, Volcano, Sansa, Zlatnik
 * Уведомление отправляется один раз при достижении порога времени.
 */

const constants = require('../config/constants.js');
const { getSportEmoji } = require('../integrations/telegram-notifier.js');
// Букмекеры для которых работает мониторинг
const MONITORED_BOOKMAKERS = ['lobbet', 'volcano', 'sansa', 'sansabet', 'zlatnik'];

// Telegram chat ID для уведомлений (чат "15+")
const HIGH_ROI_CHAT_ID = -1003230875130;

class LongLivedBetMonitor {
    constructor(options = {}) {
        this.telegram = options.telegram;
        this.logger = options.logger || console;
        this.isPrematch = options.isPrematch || false;
        this.bookmakerName = (options.bookmakerName || '').toLowerCase();
        
        // Пороги из констант
        this.roiThreshold = options.roiThreshold ?? constants.LONG_LIVED_ROI_THRESHOLD;
        this.liveThresholdMs = (options.liveSeconds ?? constants.LONG_LIVED_LIVE_SECONDS) * 1000;
        this.prematchThresholdMs = (options.prematchSeconds ?? constants.LONG_LIVED_PREMATCH_SECONDS) * 1000;
        
        // Отслеживаем уже отправленные уведомления (чтобы не дублировать)
        this.notifiedKeys = new Set();
        
        // Проверяем, нужно ли мониторить этот букмекер
        this.isMonitored = MONITORED_BOOKMAKERS.some(b => this.bookmakerName.includes(b));
        
        if (this.isMonitored) {
            const thresholdSec = this.isPrematch 
                ? this.prematchThresholdMs / 1000 
                : this.liveThresholdMs / 1000;
            this.logger.log(`📊 LongLivedBetMonitor: ${this.bookmakerName} (${this.isPrematch ? 'PREMATCH' : 'LIVE'}) - threshold ${thresholdSec}s, ROI >= ${this.roiThreshold}%`);
        }
    }

    /**
     * Проверить tracker и отправить уведомление если нужно
     * @param {Object} tracker - StabilityTracker tracker object
     * @returns {boolean} - true если уведомление отправлено
     */
    async check(tracker) {
        if (!this.isMonitored || !this.telegram) return false;
        if (!tracker || !tracker.pair) return false;
        
        const key = tracker.key;
        
        // Уже отправляли уведомление для этого tracker
        if (this.notifiedKeys.has(key)) return false;
        
        // Проверяем ROI
        const roi = tracker.lastROI;
        if (roi < this.roiThreshold) return false;
        
        // Проверяем накопленное время
        const accumulatedMs = tracker.accumulatedStabilityMs || 0;
        const thresholdMs = this.isPrematch ? this.prematchThresholdMs : this.liveThresholdMs;
        
        if (accumulatedMs < thresholdMs) return false;
        
        // Достигли порога! Отправляем уведомление
        this.notifiedKeys.add(key);
        
        try {
            await this._sendNotification(tracker, accumulatedMs);
            return true;
        } catch (e) {
            this.logger.error(`LongLivedBetMonitor: notification error: ${e.message}`);
            return false;
        }
    }

    /**
     * Отправить уведомление в Telegram
     */
    async _sendNotification(tracker, accumulatedMs) {
        const { pair, outcome, lastROI } = tracker;
        
        // Определяем стороны
        const isFirstOurs = (pair.first?.bookmaker || '').toLowerCase() === this.bookmakerName.toLowerCase();
        const ourSide = isFirstOurs ? pair.first : pair.second;
        const pinnacle = isFirstOurs ? pair.second : pair.first;
        
        const home = ourSide?.homeName || pair.first?.homeName || 'Unknown';
        const away = ourSide?.awayName || pair.first?.awayName || 'Unknown';
        const league = ourSide?.leagueName || pair.first?.leagueName || 'Unknown';
        const sport = pair.sportName || 'Unknown';
        
        // Odds
        const ourOdds = isFirstOurs 
            ? tracker.outcomeData?.score1?.value 
            : tracker.outcomeData?.score2?.value;
        const pinnacleOdds = isFirstOurs 
            ? tracker.outcomeData?.score2?.value 
            : tracker.outcomeData?.score1?.value;
        
        const betType = this.isPrematch ? '⏰ PREMATCH' : '🔴 LIVE';
        const durationSec = (accumulatedMs / 1000).toFixed(1);
        const bookmakerDisplay = this.bookmakerName.charAt(0).toUpperCase() + this.bookmakerName.slice(1);
        
        const message = [
            `🔥 <b>LONG-LIVED VALUE BET</b> ${betType}`,
            ``,
            `📊 <b>ROI: ${lastROI.toFixed(2)}%</b> | ⏱️ ${durationSec}s`,
            ``,
            `🏠 ${home}`,
            `🏃 ${away}`,
            `🏆 ${league}`,
            `${getSportEmoji(sport)} ${sport}`,
            ``,
            `🎯 <b>${outcome}</b>`,
            `💰 ${bookmakerDisplay}: <b>${ourOdds || 'N/A'}</b>`,
            `📌 Pinnacle: ${pinnacleOdds || 'N/A'}`,
            ``,
            `#${bookmakerDisplay.toLowerCase()} #longlived #roi${Math.floor(lastROI)}`
        ].join('\n');

        // Send to HIGH_ROI chat using analyzer bot (autobetting bot may not have access to this chat)
        const ANALYZER_BOT_TOKEN = process.env.TG_ALERT_TOKEN || '';
        try {
            const https = require('https');
            const postData = new URLSearchParams({
                chat_id: String(HIGH_ROI_CHAT_ID),
                text: message,
                parse_mode: 'HTML'
            }).toString();
            await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'api.telegram.org',
                    path: `/bot${ANALYZER_BOT_TOKEN}/sendMessage`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }, (res) => {
                    let body = '';
                    res.on('data', d => body += d);
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(body);
                            if (!parsed.ok) {
                                this.logger.log(`⚠️ LongLived TG error: ${parsed.description}`);
                            }
                        } catch(pe) {}
                        resolve();
                    });
                });
                req.on('error', (e) => { this.logger.log(`⚠️ LongLived TG failed: ${e.message}`); resolve(); });
                req.write(postData);
                req.end();
            });
        } catch (e) {
            this.logger.log(`⚠️ LongLived TG send failed: ${e.message}`);
        }
        
        this.logger.log(`📤 Long-lived notification sent: ${home} vs ${away} | ${outcome} | ROI ${lastROI.toFixed(2)}% | ${durationSec}s`);
    }

    /**
     * Очистить старые записи (вызывать периодически)
     */
    cleanup(maxAge = 300000) {
        // Очищаем notifiedKeys старше 5 минут
        // Но у нас нет timestamp для каждого key, поэтому просто ограничиваем размер
        if (this.notifiedKeys.size > 1000) {
            const keysArray = Array.from(this.notifiedKeys);
            this.notifiedKeys = new Set(keysArray.slice(-500));
        }
    }

    /**
     * Получить статистику
     */
    getStats() {
        return {
            isMonitored: this.isMonitored,
            bookmaker: this.bookmakerName,
            isPrematch: this.isPrematch,
            notifiedCount: this.notifiedKeys.size,
            roiThreshold: this.roiThreshold,
            thresholdMs: this.isPrematch ? this.prematchThresholdMs : this.liveThresholdMs
        };
    }
}

module.exports = { LongLivedBetMonitor, HIGH_ROI_CHAT_ID, MONITORED_BOOKMAKERS };
