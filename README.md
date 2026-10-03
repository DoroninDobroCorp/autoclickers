# Общая автоматизация ставок

Код организован по букмекерам: bookmakers/<bookmaker>/<variant>. У 1win отдельны value-executor (Node.js, бывший Big Value) и robin (Python/браузер, бывший RobinArb). У Betfair отдельны exchange, sportsbook и Node-адаптер. Desktop варианты Marathon, Ladbrokes, Olimp, Sansabet, Napoleon сохранены отдельно. Отсутствующие исходники Favbet/Winline не считаются готовыми адаптерами.

core/node и core/python содержат общие задачи, сессии, ошибки, поиск исходов, ограничения, Telegram intake и интеграционные клиенты. Код решений value и частные пороги не находятся здесь: приложение передаёт задачу и конфигурацию. Реальные счета, сессии, состояния, журналы и отчёты находятся вне общих исходников.

core/go/notifications — отдельный Go-модуль betting/notifications для Telegram service alerts и повторной доставки. Big Value livebot использует его при сборке; свои startup тексты и recipients остаются в приватном адаптере. Тесты модуля и private livebot проходят с race detector, без Telegram сообщений. Другие Go-сервисы могут подключать тот же модуль.

По сообщению владельца, на Mac также есть универсальный автопроставлятор из Jev. Он не переносился и не проверялся в этой работе; для включения в общий каталог нужно отдельно сверить его интерфейсы и варианты исполнителей. На Mac файлов не создаём.

Pinnacle provider API запрещён; browser/accounts runtime на serverforvovka не включать. Наличие адаптера не означает, что он запущен или допущен к реальным ставкам.

## Дополнения 03.10.2026: Betfair/VBet и изоляция уведомлений

Общие API-адаптеры восстановлены из сохранённого Git, а не из конфигов работающих аккаунтов:
- bookmakers/betfair/legacy-api — BetfairAdapter / BetfairClient;
- bookmakers/vbet/legacy-api — VBetAdapter / SwarmClient;
- существующие node-adapter обёртки принимают эти реализации через legacyAdapter.

Обе реализации используют единственные core/node/betting/BettorAdapter и core/node/parsers/outcome-parser. Парсеры collectors подключают эту же зависимость; копии legacy adapters внутри приложений не нужны. Восстановлены и пройдены 27 unit-тестов с mock-клиентами. Реальная отправка ставок и запуск аккаунтов не включались.

TelegramNotifier больше не содержит фиксированных чатов владельца. Получателей задаёт продукт через logsChatId/bookmakerChatIds/subscribers. Счётчики сохраняются в config.countersFile, AUTOMATION_COUNTERS_FILE или AUTOMATION_RUNTIME_ROOT/.bet_counters.json. Без явного runtime счётчики живут только в памяти. Runtime должен быть отдельным для каждого продукта; файлы создаются с правом 0600. Это номера уведомлений, не финансовый журнал. Прежний runtime-файл сохранён в закрытом Git владельца перед удалением из общих исходников.
