# Статистика registry

`src/telemetry/client.ts` получает RuntimeContext, версию CLI и опции
`disabled`/`timeoutMs`. Использует только переданные env/http и память процесса.
`emit(event, context, status?)` начинает независимую отправку, `flush()` ожидает
запущенные отправки. У каждой — тайм-аут 1000 ms с AbortController и Promise.race,
чтобы даже транспорт, игнорирующий abort, не задержал команду. Тело ответа
отменяется; результат доставки не влияет на установку. Redirect/credentials запрещены.

Endpoint — `SKILLS_TELEMETRY_ENDPOINT`, если задан, иначе исходный registry URL
с `/api/v1/skills/events`. Неверный endpoint пропускается. `--without-stat`,
непустые DISABLE_TELEMETRY/DO_NOT_TRACK отключают отправку. Клиент не пишет файлы,
не создаёт постоянную очередь, не повторяет попытки и не отправляет usage.

Пример wire-envelope по контракту backend:

```json
{
  "schemaVersion": 1,
  "eventId": "42058cb2-710b-4d86-9ed3-744fdf06b2b8",
  "event": "install",
  "occurredAt": "2026-10-13T10:00:00.000Z",
  "cliVersion": "0.1.0",
  "skill": {
    "name": "demo",
    "sourceType": "registry",
    "source": "http://localhost:8000"
  },
  "context": {
    "operation": "add",
    "scope": "project",
    "agents": ["claude-code", "codex"],
    "version": "1.2.3",
    "status": "success"
  }
}
```

У download такой же envelope без status. EventId — новый UUID для каждого события.
Версия отсутствует, если metadata latest ещё не разрешены. Подписанные URL,
локальные пути, описание скилла и текст ошибки не входят в envelope.

Download учитывает реально полученные байты с проверенными размером/SHA-256,
даже если распаковка затем отвергнута. Install описывает исход одного скилла:
success/partial увеличивают счётчик backend один раз, failed хранится без увеличения.
Новое/восстановленное подключение учитывается, metadata-only/unchanged/pinned
пропускаются. Контекст агентов описывает всех затронутых общей копией.
Restore исключён из MVP; разрешённые operation — add/update.

Проверки — `tests/telemetry.test.ts`: подменяемый транспорт, ошибки/тайм-аут,
реальные локальные HTTP-серверы и дочерний CLI с изолированными cwd/home/env.

Выбранная через find установка использует operation add и те же события.
Загрузка/фильтрация каталога, выход без выбора и отмена меню агентов не отправляют
события. Find поддерживает --without-stat в общей и командной позиции.
