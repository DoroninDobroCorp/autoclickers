# Общая автоматизация ставок

Код организован по букмекерам: bookmakers/<bookmaker>/<variant>. У 1win отдельны value-executor (Node.js, бывший Big Value) и robin (Python/браузер, бывший RobinArb). У Betfair отдельны exchange, sportsbook и Node-адаптер. Desktop варианты Marathon, Ladbrokes, Olimp, Sansabet, Napoleon сохранены отдельно. Отсутствующие исходники Favbet/Winline не считаются готовыми адаптерами.

core/node и core/python содержат общие задачи, сессии, ошибки, поиск исходов, ограничения, Telegram intake и интеграционные клиенты. Код решений value и частные пороги не находятся здесь: приложение передаёт задачу и конфигурацию. Реальные счета, сессии, состояния, журналы и отчёты находятся вне общих исходников.

core/go/notifications — отдельный Go-модуль betting/notifications для Telegram service alerts и повторной доставки. Big Value livebot использует его при сборке; свои startup тексты и recipients остаются в приватном адаптере. Тесты модуля и private livebot проходят с race detector, без Telegram сообщений. Другие Go-сервисы могут подключать тот же модуль.

По сообщению владельца, на Mac также есть универсальный автопроставлятор из Jev. Он не переносился и не проверялся в этой работе; для включения в общий каталог нужно отдельно сверить его интерфейсы и варианты исполнителей. На Mac файлов не создаём.

Pinnacle provider API запрещён; browser/accounts runtime на serverforvovka не включать. Наличие адаптера не означает, что он запущен или допущен к реальным ставкам.
