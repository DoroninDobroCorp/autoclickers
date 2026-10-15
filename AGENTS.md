# Основная ветка: решение владельца 15.10.2026

Единственная интеграционная ветка всех модулей — `main`. Основные checkout должны работать на `main`; ветки `split/step-*`, `maintenance/*`, `fix/*` не являются отдельными постоянными контурами.

Проверенное улучшение в рамках порученной задачи сразу коммитить и интегрировать в `main`, затем отправлять в канонический remote этого модуля. Не оставлять готовый результат в candidate-ветке и не просить отдельное разрешение на обычные commit/push в main. По умолчанию работать прямо в main. Если изоляция действительно необходима, временную ветку объединить и удалить после интеграции в той же задаче.

Перед интеграцией сверить актуальные refs и незакоммиченные изменения других чатов. Историю сохранять обычным fast-forward/merge, без force push. Более свежая дата — ориентир; учитывать намеренные откаты и совместимость. Не подмешивать незавершённый WIP под видом проверенного улучшения. После разрешения конфликтов запускать адресные существенные проверки, а не все исторические тесты по кругу.

Правило имеет приоритет над прежними указаниями оставлять готовые изменения в step/candidate/maintenance ветках. Commit/push в main не подменяет разрешение на отдельные денежные операции, запуск новых источников или произвольный rebuild/restart сервисов; существующий разрешённый CI выпуска сохраняется.

# Automation boundary

Shared execution code only. Never add value calculation, owner tokens, sessions, production account state or private Big Value records. Use external project config/state directories. Owner authorization of 2026-10-04 permits the shared BIA feed and the extracted read-only Pinnacle/PS3838 API collector on dev when its account is verified alive. Do not enable external Pinnacle API, account or browser runtime on serverforvovka. No live betting is authorized by this data-source access. Consumers provide tasks and private policy. Keep compatibility adapters explicit.
