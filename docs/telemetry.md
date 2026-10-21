# Статистика registry

[Telemetry](../src/telemetry/client.ts) получает RuntimeContext и версию CLI.
`emit()` начинает отправку, `flush()` ожидает текущие отправки. CLI вызывает flush
в finally после add/update. Отдельного события find нет: выбранная установка — operation=add.

| Событие    | Когда отправляется                                                                            |
| ---------- | --------------------------------------------------------------------------------------------- |
| `download` | Получены байты архива и проверены размер/SHA-256, даже если последующая распаковка не удалась |
| `install`  | Результат одного скилла: success/partial/failed, один раз независимо от числа агентов         |

Чистый повтор, изменение только latest/exact, пропуск exact и отказ/отмена не создают
install. Новое/восстановленное подключение создаёт install без download, если копия цела.
Локальные источники, list/remove и чтение каталога/карточки событий не отправляют.

Endpoint: `SKILLS_TELEMETRY_ENDPOINT` либо `<исходный-registry>/api/v1/skills/events`.
`--without-stat` и любое непустое `DISABLE_TELEMETRY`/`DO_NOT_TRACK` отключают отправку.

Envelope версии 1 содержит eventId (UUID), event, occurredAt, cliVersion,
skill `{ name: slug, sourceType: registry, source: registryUrl }` и context
`{ operation, scope, agents, version?, status? }`. Status задан у install; версия
может отсутствовать при ошибке разрешения latest. Подписанные URL, локальные пути
и тексты ошибок не отправляются. Backend-событие `install` сохраняет своё имя,
хотя команда CLI называется add.

Тайм-аут отправки — 1 секунда; AbortController и Promise.race ограничивают ожидание
даже для транспорта, игнорирующего abort. Redirects/credentials запрещены. Ошибка,
неверный endpoint или тайм-аут не меняют файлы и результат команды. Постоянной очереди,
файлов статистики и повторных попыток нет.

Контракт backend: `../ai-tools-core/docs/openapi/swagger.yaml`. Условия событий
проверяет [installer-events](../tests/unit/installer-events.test.ts), транспорт —
[telemetry-client](../tests/unit/telemetry-client.test.ts), отправку через Installer —
[интеграционные тесты](../tests/integration/telemetry.test.ts).
