const https = require('https');
const fsp = require('fs/promises');
const path = require('path');

class TelegramBotClient {
  constructor(config = {}) {
    this.botToken = config.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
    this.logger = config.logger || console;
    this.apiHost = config.apiHost || 'api.telegram.org';

    if (!this.botToken) {
      throw new Error('TelegramBotClient requires bot token');
    }
  }

  async getUpdates(options = {}) {
    const query = new URLSearchParams();
    if (Number.isFinite(options.offset)) query.set('offset', String(options.offset));
    if (Number.isFinite(options.timeout)) query.set('timeout', String(options.timeout));
    if (Array.isArray(options.allowedUpdates) && options.allowedUpdates.length > 0) {
      query.set('allowed_updates', JSON.stringify(options.allowedUpdates));
    }

    const result = await this._apiGet(`/bot${this.botToken}/getUpdates?${query.toString()}`);
    if (!result.ok) {
      throw new Error(result.description || 'Telegram getUpdates failed');
    }

    return result.result || [];
  }

  getBotUserId() {
    const rawId = String(this.botToken || '').split(':', 1)[0];
    const userId = Number(rawId);
    return Number.isFinite(userId) && userId > 0 ? userId : null;
  }

  async getChat(chatId) {
    if (chatId === null || chatId === undefined || chatId === '') {
      throw new Error('getChat requires chatId');
    }

    const query = new URLSearchParams({ chat_id: String(chatId) });
    const result = await this._apiGet(`/bot${this.botToken}/getChat?${query.toString()}`);
    if (!result.ok) {
      throw new Error(result.description || `Telegram getChat failed for ${chatId}`);
    }

    return result.result || null;
  }

  async getChatMember(chatId, userId) {
    if (chatId === null || chatId === undefined || chatId === '') {
      throw new Error('getChatMember requires chatId');
    }
    if (!Number.isFinite(Number(userId))) {
      throw new Error('getChatMember requires userId');
    }

    const query = new URLSearchParams({
      chat_id: String(chatId),
      user_id: String(userId)
    });
    const result = await this._apiGet(`/bot${this.botToken}/getChatMember?${query.toString()}`);
    if (!result.ok) {
      throw new Error(result.description || `Telegram getChatMember failed for ${chatId}/${userId}`);
    }

    return result.result || null;
  }

  async getFile(fileId) {
    if (!fileId) {
      throw new Error('getFile requires fileId');
    }

    const query = new URLSearchParams({ file_id: String(fileId) });
    const result = await this._apiGet(`/bot${this.botToken}/getFile?${query.toString()}`);
    if (!result.ok) {
      throw new Error(result.description || `Telegram getFile failed for ${fileId}`);
    }

    return result.result || null;
  }

  async sendMessage(chatId, text, options = {}) {
    if (chatId === null || chatId === undefined || chatId === '') {
      throw new Error('sendMessage requires chatId');
    }

    const payload = {
      chat_id: chatId,
      text: text || ''
    };

    if (options.parse_mode !== null) {
      payload.parse_mode = options.parse_mode || 'HTML';
    }
    if (options.disable_web_page_preview !== undefined) {
      payload.disable_web_page_preview = options.disable_web_page_preview;
    } else {
      payload.disable_web_page_preview = true;
    }
    if (options.reply_markup !== undefined) {
      payload.reply_markup = options.reply_markup;
    }
    if (Number.isFinite(options.reply_to_message_id)) {
      payload.reply_to_message_id = options.reply_to_message_id;
    }
    if (Number.isFinite(options.message_thread_id)) {
      payload.message_thread_id = options.message_thread_id;
    }
    if (options.allow_sending_without_reply !== undefined) {
      payload.allow_sending_without_reply = options.allow_sending_without_reply;
    }

    return this._apiPost('sendMessage', payload);
  }

  async answerCallbackQuery(callbackQueryId, text = '', options = {}) {
    if (!callbackQueryId) {
      throw new Error('answerCallbackQuery requires callbackQueryId');
    }

    const payload = {
      callback_query_id: callbackQueryId,
      text: text || undefined,
      show_alert: options.show_alert === true
    };

    if (Number.isFinite(options.cache_time)) {
      payload.cache_time = options.cache_time;
    }

    return this._apiPost('answerCallbackQuery', payload);
  }

  async editMessageReplyMarkup(chatId, messageId, replyMarkup = { inline_keyboard: [] }) {
    if (chatId === null || chatId === undefined || chatId === '') {
      throw new Error('editMessageReplyMarkup requires chatId');
    }
    if (!Number.isFinite(Number(messageId))) {
      throw new Error('editMessageReplyMarkup requires messageId');
    }

    return this._apiPost('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: Number(messageId),
      reply_markup: replyMarkup || { inline_keyboard: [] }
    });
  }

  async downloadFile(filePath) {
    if (!filePath) {
      throw new Error('downloadFile requires filePath');
    }

    return this._download(`/file/bot${this.botToken}/${filePath}`);
  }

  async downloadFileToPath(filePath, destinationPath) {
    const buffer = await this.downloadFile(filePath);
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsp.writeFile(destinationPath, buffer);
    return destinationPath;
  }

  async downloadFileById(fileId, destinationDir, options = {}) {
    const file = await this.getFile(fileId);
    if (!file?.file_path) {
      throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
    }

    const ext = path.extname(file.file_path) || options.defaultExtension || '.jpg';
    const requestedFileName = options.fileName || `tg_${Date.now()}_${fileId}`;
    const baseName = path.extname(requestedFileName)
      ? requestedFileName
      : `${requestedFileName}${ext}`;
    const destinationPath = path.join(destinationDir, baseName);
    await this.downloadFileToPath(file.file_path, destinationPath);
    return {
      fileId,
      filePath: file.file_path,
      destinationPath
    };
  }

  async _apiGet(requestPath) {
    const body = await this._rawRequest({
      hostname: this.apiHost,
      path: requestPath,
      method: 'GET'
    });

    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`Failed to parse Telegram JSON response: ${error.message}`);
    }
  }

  async _apiPost(methodName, payload = {}) {
    const body = await this._rawRequest({
      hostname: this.apiHost,
      path: `/bot${this.botToken}/${methodName}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, JSON.stringify(payload));

    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`Failed to parse Telegram JSON response: ${error.message}`);
    }
  }

  async _download(requestPath) {
    const response = await this._rawBinaryRequest({
      hostname: this.apiHost,
      path: requestPath,
      method: 'GET'
    });
    return response;
  }

  _rawRequest(options, payload = null) {
    return new Promise((resolve, reject) => {
      const finalOptions = {
        ...options,
        headers: {
          ...(options.headers || {})
        }
      };

      const data = payload === null ? null : String(payload);
      if (data !== null) {
        finalOptions.headers['Content-Length'] = Buffer.byteLength(data);
      }

      const req = https.request(finalOptions, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Telegram HTTP ${res.statusCode}: ${body}`));
            return;
          }
          resolve(body);
        });
      });

      req.on('error', reject);
      if (data !== null) {
        req.write(data);
      }
      req.end();
    });
  }

  _rawBinaryRequest(options) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Telegram file download failed: HTTP ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      });

      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = { TelegramBotClient };
