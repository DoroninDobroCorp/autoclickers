/**
 * AI Analyzer for Debug Collector
 * Uses Google Vertex AI for error analysis
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { GoogleAuth } = require('google-auth-library');

class AIAnalyzer {
    constructor(config = {}) {
        this.config = {
            projectId: config.projectId || 'poised-shuttle-479119-i0',
            location: config.location || 'us-central1',
            model: config.model || 'gemini-2.0-flash-001',
            serviceAccountFile: config.serviceAccountFile || '/srv/big_value/backend/auto_matcher/configs/poised-shuttle-479119-i0-3b1915ae418e.json',
            outputDir: config.outputDir || '/srv/big_value/logs/debug/analysis',
            mappingsDir: config.mappingsDir || null, // Will be set per bookmaker
            ...config
        };
        
        this.logger = config.logger || console;
        this.auth = null;
        this.suggestions = []; // Accumulated fix suggestions
        
        // Create output directory
        if (!fs.existsSync(this.config.outputDir)) {
            fs.mkdirSync(this.config.outputDir, { recursive: true });
        }
        
        this._initAuth();
    }
    
    async _initAuth() {
        try {
            // Set credentials environment variable
            process.env.GOOGLE_APPLICATION_CREDENTIALS = this.config.serviceAccountFile;
            
            this.auth = new GoogleAuth({
                scopes: ['https://www.googleapis.com/auth/cloud-platform']
            });
            
            this.logger.log(`🤖 [AI] Initialized Vertex AI (project: ${this.config.projectId})`);
        } catch (err) {
            this.logger.log(`🤖 [AI] Failed to init auth: ${err.message}`);
        }
    }
    
    /**
     * Build prompt for error analysis
     */
    buildPrompt(error) {
        const { bookmaker, errorType, outcomeType, context } = error;
        
        // Read mappings code if available
        let mappingsCode = 'N/A';
        if (this.config.mappingsDir) {
            const mappingsFile = path.join(this.config.mappingsDir, 'mappings.js');
            if (fs.existsSync(mappingsFile)) {
                mappingsCode = fs.readFileSync(mappingsFile, 'utf8').slice(0, 4000);
            }
            const selectionFinderFile = path.join(this.config.mappingsDir, 'selection-finder.js');
            if (fs.existsSync(selectionFinderFile)) {
                mappingsCode += '\n\n// selection-finder.js\n' + fs.readFileSync(selectionFinderFile, 'utf8').slice(0, 4000);
            }
        }
        
        // Format raw data
        const rawData = context.rawMatch ? JSON.stringify(context.rawMatch, null, 2).slice(0, 5000) : 'N/A';
        const availableMarkets = context.availableMarkets ? 
            context.availableMarkets.slice(0, 30).map(m => 
                typeof m === 'string' ? m : JSON.stringify(m)
            ).join('\n') : 'N/A';
        
        return `
# Задача: Диагностика ошибки автобеттинга

## Контекст
- Букмекер: ${bookmaker}
- Тип ошибки: ${errorType}
- Тип исхода: ${outcomeType}
- Исход: ${context.outcome}
- Ожидаемый коэффициент: ${context.expectedOdds || 'N/A'}
- Найденный коэффициент: ${context.foundOdds || 'не найден'}
- Матч: ${context.match?.home || '?'} vs ${context.match?.away || '?'}

## Доступные рынки на букмекере (первые 30)
${availableMarkets}

## Сырые данные от API букмекера (если есть)
\`\`\`json
${rawData}
\`\`\`

## Текущий код маппинга/поиска
\`\`\`javascript
${mappingsCode}
\`\`\`

## Твоя задача
1. Определи ТОЧНУЮ причину почему исход "${context.outcome}" не найден или коэффициент не совпадает
2. Посмотри на доступные рынки - есть ли там нужный исход под другим названием/ID?
3. Предложи КОНКРЕТНОЕ исправление кода

## Формат ответа (ТОЛЬКО JSON, без markdown)
{
  "diagnosis": "Краткое описание проблемы (1-2 предложения)",
  "rootCause": "Техническая причина (детально)",
  "foundInData": "Где в сырых данных находится нужный исход (если нашёл)",
  "suggestedFix": {
    "file": "имя файла для изменения",
    "description": "что нужно изменить",
    "codeBefore": "текущий код (1-3 строки)",
    "codeAfter": "исправленный код (1-3 строки)",
    "confidence": 0.85
  },
  "alternativeFixes": [],
  "needsMoreData": false
}
`;
    }
    
    /**
     * Call Vertex AI API
     */
    async callVertexAI(prompt) {
        if (!this.auth) {
            throw new Error('Auth not initialized');
        }
        
        const accessToken = await this.auth.getAccessToken();
        
        const endpoint = `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${this.config.projectId}/locations/${this.config.location}/publishers/google/models/${this.config.model}:generateContent`;
        
        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 2048,
                topP: 0.8
            }
        };
        
        return new Promise((resolve, reject) => {
            const url = new URL(endpoint);
            const options = {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Vertex AI error ${res.statusCode}: ${data}`));
                        return;
                    }
                    
                    try {
                        const json = JSON.parse(data);
                        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (!text) {
                            reject(new Error('Empty response from Vertex AI'));
                            return;
                        }
                        resolve(text);
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${e.message}`));
                    }
                });
            });
            
            req.on('error', reject);
            req.write(JSON.stringify(requestBody));
            req.end();
        });
    }
    
    /**
     * Analyze an error and get fix suggestion
     */
    async analyze(error) {
        const prompt = this.buildPrompt(error);
        
        this.logger.log(`🤖 [AI] Analyzing ${error.outcomeType} error...`);
        
        try {
            const response = await this.callVertexAI(prompt);
            
            // Parse JSON response
            let analysis;
            try {
                // Remove potential markdown wrapping
                const jsonStr = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                analysis = JSON.parse(jsonStr);
            } catch (e) {
                this.logger.log(`🤖 [AI] Failed to parse JSON, raw response: ${response.slice(0, 500)}`);
                analysis = { rawResponse: response, parseError: e.message };
            }
            
            // Log analysis
            this.logger.log(`🤖 [AI] Analysis for ${error.outcomeType}:`);
            this.logger.log(`   Diagnosis: ${analysis.diagnosis || 'N/A'}`);
            this.logger.log(`   Root cause: ${analysis.rootCause || 'N/A'}`);
            if (analysis.suggestedFix) {
                this.logger.log(`   Suggested fix (${(analysis.suggestedFix.confidence * 100).toFixed(0)}% confidence):`);
                this.logger.log(`   File: ${analysis.suggestedFix.file}`);
                this.logger.log(`   ${analysis.suggestedFix.description}`);
            }
            
            // Save to file
            const result = {
                timestamp: Date.now(),
                error,
                analysis,
                prompt: prompt.slice(0, 1000) + '...'
            };
            
            this.suggestions.push(result);
            
            const outputFile = path.join(
                this.config.outputDir, 
                `${error.bookmaker}_${error.outcomeType}_${Date.now()}.json`
            );
            fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
            
            return analysis;
            
        } catch (err) {
            this.logger.log(`🤖 [AI] Analysis failed: ${err.message}`);
            throw err;
        }
    }
    
    /**
     * Get all accumulated suggestions
     */
    getSuggestions() {
        return this.suggestions;
    }
    
    /**
     * Save summary of all suggestions
     */
    saveSummary() {
        const summaryFile = path.join(this.config.outputDir, 'suggestions_summary.json');
        fs.writeFileSync(summaryFile, JSON.stringify({
            timestamp: Date.now(),
            totalSuggestions: this.suggestions.length,
            suggestions: this.suggestions
        }, null, 2));
        
        this.logger.log(`🤖 [AI] Saved ${this.suggestions.length} suggestions to ${summaryFile}`);
    }
}

module.exports = { AIAnalyzer };
