// Package notifications provides reusable delivery for service Telegram alerts.
// Product message policy, recipients and credentials belong to the caller.
package notifications

import (
	"context"
	"fmt"
	"net/http"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/rs/zerolog"
)

type Sender interface {
	Send(tgbotapi.Chattable) (tgbotapi.Message, error)
}

type TelegramAlerter struct {
	sender     Sender
	chatID     int64
	logger     zerolog.Logger
	retryCount int
	retryDelay time.Duration
}

func NewTelegramAlerter(token string, chatID int64, logger *zerolog.Logger, retryCount int, retryDelay time.Duration) (*TelegramAlerter, error) {
	if token == "" {
		return nil, fmt.Errorf("alert bot token is empty")
	}
	bot, err := tgbotapi.NewBotAPIWithClient(token, tgbotapi.APIEndpoint, &http.Client{Timeout: 30 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("failed to create alert bot: %w", err)
	}
	return NewWithSender(bot, chatID, logger, retryCount, retryDelay)
}

// NewWithSender reuses a caller's configured client without a network lookup.
func NewWithSender(sender Sender, chatID int64, logger *zerolog.Logger, retryCount int, retryDelay time.Duration) (*TelegramAlerter, error) {
	if sender == nil {
		return nil, fmt.Errorf("alert sender is nil")
	}
	if retryCount < 0 || retryDelay < 0 {
		return nil, fmt.Errorf("negative alert retry settings")
	}
	log := zerolog.Nop()
	if logger != nil {
		log = *logger
	}
	return &TelegramAlerter{sender: sender, chatID: chatID, logger: log, retryCount: retryCount, retryDelay: retryDelay}, nil
}

func (a *TelegramAlerter) SendAlert(ctx context.Context, message string) error {
	return a.send(ctx, "🚨 Alert", message, a.retryCount+1)
}
func (a *TelegramAlerter) SendCriticalAlert(ctx context.Context, message string) error {
	return a.send(ctx, "🔴 CRITICAL", message, a.retryCount+1)
}
func (a *TelegramAlerter) SendRecoveryAlert(ctx context.Context, message string) error {
	return a.send(ctx, "✅ RECOVERY", message, 1)
}

func (a *TelegramAlerter) send(ctx context.Context, kind, message string, attempts int) error {
	if ctx == nil {
		ctx = context.Background()
	}
	msg := tgbotapi.NewMessage(a.chatID, fmt.Sprintf("%s: %s (Time: %s)", kind, message, time.Now().Format("2006-01-02 15:04:05")))
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if attempt > 0 {
			timer := time.NewTimer(a.retryDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		_, err := a.sender.Send(msg)
		if err == nil {
			return nil
		}
		lastErr = err
		a.logger.Error().Err(err).Int("attempt", attempt+1).Int("attempts", attempts).Msg("Failed to send service alert")
	}
	return fmt.Errorf("failed to send service alert after %d attempts: %w", attempts, lastErr)
}
