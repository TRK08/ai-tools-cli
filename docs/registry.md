# Внутренний registry-клиент

`src/registry/` не зависит от UI, агентов и записи lock. Транспорт передаётся из
`RuntimeContext.http`; URL вычисляется из явной опции и `context.env`, без чтения
глобального окружения внутри клиента. Авторизации и событий в 007 нет.

```ts
const client = new RegistryClient(getRegistryUrl(explicitUrl, runtime.env), runtime.http);
const artifact = await client.resolveArtifact({ slug: 'demo', version: '1.2.3' });
// Installer сравнивает metadata с lock до скачивания в add/update.
const { bytes, download } = await client.downloadArtifact(artifact);
```

Это внутренний контракт, не публичный SDK. `resolveArtifact` запрашивает
`GET <registry>/api/v1/skills/{slug}/artifact`; только exact добавляет `?version=...`.
Ответ соответствует `../ai-tools-core/docs/openapi/swagger.yaml`: `slug`, `version`,
`sha256`, `size`, `format: tar.gz`, `url`, `expiresAt`. Клиент проверяет совпадение
slug и запрошенной версии, полный SemVer, нижний hex SHA-256, положительный целый
размер до 20 MiB, формат, HTTP(S) URL без credentials/fragment и дату истечения.
JSON ограничен 64 KiB, неверный UTF-8/JSON и неподходящие поля дают ошибку.

Каждый HTTP-запрос имеет тайм-аут 30 секунд, включая чтение тела. Redirect запрещён,
credentials не передаются. Ошибки 404 описывают отсутствующий скилл/версию,
503 — временную недоступность. Backend использует `{ code, message, debugMessage }`
с `not_found`/`service_unavailable`; сообщения CLI определяются статусом и запросом,
не копируют произвольный текст ответа или подписанный URL.

`downloadArtifact` получает ограниченные байты, сверяет их размер и SHA-256 и только
после этого возвращает Buffer. Если `expiresAt` уже прошло либо скачивание вернуло
401/403, разрешён один refresh. Он всегда запрашивает исходную фактическую версию,
даже если первоначальный запрос был latest. Новые slug/version/format проверяются
общей функцией; смена размера/digest и повторно истёкший URL отвергаются.
После refresh второй 401/403 завершает операцию. Остальные ошибки не повторяются.

`RegistryDownload` содержит только `registryUrl`, `slug`, `version`, `archiveHash`
и фактический `size`. `downloadArtifact` возвращает его отдельно от байтов;
адаптер также передаёт его в `PreparedSource.download`, результат Installer и
необязательный `onDownload` после проверки скачивания. В 010 Installer использует callback для события download; сам клиент
не отправляет события. Подписанного URL в этих данных нет.

`prepareRegistrySource` принимает необязательные предварительно разрешённые
metadata пятым аргументом после onDownload; при их отсутствии запрашивает их сам.
Переданные slug/version проверяются на соответствие reference. Адаптер получает
проверенные байты, создаёт временный архив с
правами 0600, затем вызывает общую `prepareArchive` из 006. `SKILL.md.name` должен
совпасть со slug. Подготовленная папка содержит те же байты, бинарные ресурсы и
исполняемые права; contentHash вычисляется общим модулем State. Самостоятельный
вызов обязан вызвать `cleanup`, Installer очищает весь workspace своей транзакции.

Lock версии 1 уже поддерживает registry: `source: { kind: registry, registryUrl, slug }`,
фактическую `version`, политику latest/exact, `archiveHash` и `contentHash`.
Схема дополнительно проверяет slug/SemVer и соответствие slug имени записи.
Временный download URL и путь подготовленного архива не сохраняются.

`registryReferenceForSource` оставляет существующий bare path локальным (включая
сломанные symlink). Явные пути и archive suffix также не становятся registry.
Без существующего пути распознаются `slug` и `slug@version`; проверка агента и
отмена Clack выполняются раньше определения источника и HTTP.

Проверки используют настоящий HTTP-сервер на `127.0.0.1` с контрактными ответами,
изолированные cwd/home/env и подменяемый транспорт/тайм-аут. В песочнице, запрещающей
listen, нужен разрешённый запуск этих тестов. Реальные установки агентов не затрагиваются.

```sh
npm run test:run -- tests/registry-client.test.ts tests/registry-installer.test.ts tests/registry-cli.test.ts
```

Коды `RegistryError`: `INVALID_REFERENCE`, `INVALID_REGISTRY`, `NOT_FOUND`,
`REGISTRY_UNAVAILABLE`, `INVALID_RESPONSE`, `DOWNLOAD_FAILED`, `ARTIFACT_MISMATCH`,
`URL_EXPIRED`. Архивные и файловые ошибки сохраняют контракт Sources/Installer.
Байты буферизуются в пределах лимита; постоянного artifact cache нет. Оптимизация
повторного скачивания и update реализованы в 008, события — в 010. Restore исключён из MVP.

## Поиск и карточка (010)

`listSkills(slugPrefix?, signal?)` получает `GET <registry>/api/v1/skills`.
Если префикс задан, он передаётся через URLSearchParams в slugPrefix без изменения
регистра, разбиения на слова или локальной фильтрации. Ответ `{ items }`
валидируется по полям вывода и ограничен 8 MiB; installCount — неотрицательное
безопасное целое. Полученные результаты CLI сортирует по популярности и slug.

По Swagger и тесту TestListSkillsSlugPrefix текущего backend префикс буквальный,
case-sensitive; `%`/`_`/кавычки не являются SQL wildcard. Отсутствующий/пустой
параметр backend возвращает весь опубликованный каталог; интерактивный find
при префиксе короче двух символов запрос не выполняет, а без TTY требует минимум
два символа. Результаты показывают slug, версию и installCount.

`getSkill(slug, version?, signal?)` получает `GET <registry>/api/v1/skills/{slug}`;
карточка установки запрашивает version выбранного артефакта;
ответ SkillDetail ограничен 4 MiB. Проверяются поля вывода, slug, полный SemVer,
longDescription и versions, включая присутствие текущей/выбранной версии
и точное совпадение ответа с явно запрошенной version. resolveArtifact также
принимает signal для отмены загрузки карточки до подтверждения.
Архив и временный skillMd URL не загружаются для показа карточки.
Общие тайм-аут, запрет redirect/credentials, проверка UTF-8/JSON и ошибки HTTP
применяются ко всем metadata-запросам. Ошибка не превращается в пустой результат.

Signal отмены объединяется с тайм-аутом. Find-search делает debounce 200 ms,
отменяет предыдущий HTTP-запрос и дополнительно проверяет номер запроса,
чтобы проигнорировать ответ транспорта, не исполнившего abort. Следующий запрос
артефакта указывает точную версию выбранного актуального результата.
