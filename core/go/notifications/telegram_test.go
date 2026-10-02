package notifications

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

type fakeSender struct {
	calls    int
	failures int
	onSend   func()
	messages []tgbotapi.MessageConfig
}

var sendFailure = errors.New("transport unavailable")

func (s *fakeSender) Send(message tgbotapi.Chattable) (tgbotapi.Message, error) {
	s.calls++
	s.messages = append(s.messages, message.(tgbotapi.MessageConfig))
	if s.onSend != nil {
		s.onSend()
	}
	if s.calls <= s.failures {
		return tgbotapi.Message{}, sendFailure
	}
	return tgbotapi.Message{}, nil
}
func TestAlertRetriesKeepRecipientAndMessage(t *testing.T) {
	sender := &fakeSender{failures: 2}
	alerter, err := NewWithSender(sender, 42, nil, 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err = alerter.SendAlert(context.Background(), "sample service down"); err != nil {
		t.Fatal(err)
	}
	if sender.calls != 3 {
		t.Fatalf("attempts: %d", sender.calls)
	}
	for _, message := range sender.messages {
		if message.ChatID != 42 || !strings.Contains(message.Text, "🚨 Alert: sample service down") {
			t.Fatalf("wrong envelope: %+v", message)
		}
		if message.Text != sender.messages[0].Text {
			t.Fatal("retry changed the original alert")
		}
	}
}
func TestExhaustionPreservesTransportCause(t *testing.T) {
	sender := &fakeSender{failures: 10}
	alerter, _ := NewWithSender(sender, 42, nil, 1, 0)
	if err := alerter.SendCriticalAlert(context.Background(), "sample"); !errors.Is(err, sendFailure) || sender.calls != 2 {
		t.Fatalf("calls=%d error=%v", sender.calls, err)
	}
}
func TestCanceledAlertSendsNothing(t *testing.T) {
	sender := &fakeSender{}
	alerter, _ := NewWithSender(sender, 42, nil, 2, 0)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := alerter.SendAlert(ctx, "sample"); !errors.Is(err, context.Canceled) || sender.calls != 0 {
		t.Fatalf("calls=%d error=%v", sender.calls, err)
	}
}
func TestCancellationInterruptsRetryWait(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sender := &fakeSender{failures: 10, onSend: cancel}
	alerter, _ := NewWithSender(sender, 42, nil, 2, time.Hour)
	if err := alerter.SendAlert(ctx, "sample"); !errors.Is(err, context.Canceled) || sender.calls != 1 {
		t.Fatalf("calls=%d error=%v", sender.calls, err)
	}
}
func TestRecoveryKeepsSingleAttempt(t *testing.T) {
	sender := &fakeSender{failures: 10}
	alerter, _ := NewWithSender(sender, 42, nil, 5, 0)
	if err := alerter.SendRecoveryAlert(context.Background(), "sample"); !errors.Is(err, sendFailure) || sender.calls != 1 {
		t.Fatalf("calls=%d error=%v", sender.calls, err)
	}
}
func TestInvalidConfigurationDoesNotNeedTelegram(t *testing.T) {
	if _, err := NewTelegramAlerter("", 42, nil, 0, 0); err == nil {
		t.Fatal("empty token accepted")
	}
	if _, err := NewWithSender(nil, 42, nil, 0, 0); err == nil {
		t.Fatal("nil sender accepted")
	}
	if _, err := NewWithSender(&fakeSender{}, 42, nil, -1, 0); err == nil {
		t.Fatal("negative retries accepted")
	}
}
