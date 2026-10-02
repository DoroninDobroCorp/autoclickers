# Общие Go уведомления

Модуль betting/notifications: доставка Telegram service alerts с ограниченным числом повторов. Токен, chat ID и политика сообщений задаются каждым продуктом; здесь нет Big Value данных или hardcoded credentials.

NewWithSender использует клиент продукта и не делает запросов при создании. NewTelegramAlerter создаёт Telegram client с HTTP timeout 30 секунд. Контекст отменяет отправку до попытки и прерывает ожидание повтора; уже выполняющийся Send ограничивается timeout клиента. Recovery сохраняет одну попытку, alert/critical — retryCount+1.

Livebot Big Value импортирует этот модуль в свой immutable образ; startup wording остаётся в его адаптере. Другие Go сервисы могут использовать тот же модуль. Node/Python транспорт остаётся в соответствующих core папках, bookmaker drivers — отдельно.

Проверка: go test -race ./...; тесты используют fake Sender и не обращаются к Telegram. Никакие реальные сообщения не отправлялись.
