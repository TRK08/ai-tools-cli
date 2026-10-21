# Проверки CLI

Числа ниже — случаи Vitest после параметризации,
включая пропуски; отдельные циклы внутри случая не считаются отдельными тестами.
Покрытие строк/ветвей не инструментировано, процент code coverage не измерялся.

## Запуск и границы

| Команда                                   | Набор                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run test:unit`                       | Изолированные компоненты: собственные временные файлы, подменённый HTTP и терминальные потоки |
| `npm run test:integration`                | Стыки Installer/источников/state/UI, настоящий Git и несколько локальных HTTP-проверок        |
| `npm run test:run`                        | Unit + integration без предварительной сборки                                                 |
| `npm run build`, затем `npm run test:e2e` | Отдельные процессы `dist/cli.mjs`, настоящие файлы и localhost registry                       |
| `npm run test:git`                        | Git-фильтр integration, работает без dist                                                     |
| `npm run test`                            | Watch unit + integration                                                                      |

Unit не запускает CLI, Installer или HTTP-сервер. Реальная работа компонента с собственным
временным каталогом допустима. Полные матрицы входов и ошибок проверяются у владельца правила;
интеграции доказывают передачу данных и сохранность установки. Тесты не используют пользовательские
home/каталоги агентов. HTTP запрещён fixture, пока транспорт не передан явно.

В CI семь jobs и один Linux tgz: в шести OS/Node-комбинациях после сборки выполняются
оба набора (`test:run`, `test:e2e`), затем короткий package smoke.
Меню и клавиши проверяются на управляемых потоках без псевдотерминала.

## Состав набора

Всего **933 случая в 65 файлах**.

| Проект      | Случаев | Файлов | Назначение                        |
| ----------- | ------: | -----: | --------------------------------- |
| unit        |     726 |     44 | Компонентные правила              |
| integration |     199 |     20 | Связность и сохранность состояния |
| e2e         |       8 |      1 | Собранный CLI                     |

Невалидные UTF-8 имена файлов проверяются только на Linux. POSIX-байтовые имена,
FIFO и ошибки chmod проверяются на POSIX; на Windows эти случаи пропускаются.
Windows-пути и junction проверяются в отдельных компонентных и интеграционных сценариях.

## Актуальный список

Для каждого файла указан проверяемый контракт.

### Компоненты

| Файл                                                                             | Случаев | Что проверяет                                                                                                          |
| -------------------------------------------------------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------- |
| [agent-configuration](../tests/unit/agent-configuration.test.ts)                 |       8 | Дополнительный агент: env, scope, валидация Windows и исключение default/активных каталогов.                           |
| [add-ui](../tests/unit/add-ui.test.ts)                                           |       7 | Карточка локального/registry-источника, группировка путей, подтверждение, область.                                     |
| [agents-catalog](../tests/unit/agents-catalog.test.ts)                           |       3 | Все пять ID, четыре общих пути, отдельный Claude, явный выбор и валидация.                                             |
| [agents-prompt](../tests/unit/agents-prompt.test.ts)                             |      16 | Закреплённая группа, поиск и отметки, клавиши, размер окна, отмена, явные -a.                                          |
| [archive-source](../tests/unit/archive-source.test.ts)                           |      62 | Tar/gzip, корень SKILL.md, traversal/PAX/GNU, специальные записи, лимиты, cleanup.                                     |
| [cli](../tests/unit/cli.test.ts)                                                 |      36 | Регистрация/русская справка, запрещённые команды, TTY, передача флагов, batch и отсутствие мутаций при отказе.         |
| [content-hash](../tests/unit/content-hash.test.ts)                               |      17 | Байты и framing, имена/ссылки, детерминированность, игнорирование прав и пустых папок.                                 |
| [directory-source](../tests/unit/directory-source.test.ts)                       |      40 | Разыменование ссылок, защита от циклов/чужих данных, ресурсы, ошибки и cleanup.                                        |
| [discovery](../tests/unit/discovery.test.ts)                                     |      27 | Каталог и карточка, кодирование буквального префикса, невалидные ответы и ошибки API.                                  |
| [errors](../tests/unit/errors.test.ts)                                           |       2 | Локализация filesystem-ошибки с кодом/путями и сохранение доменного текста.                                            |
| [file-operations](../tests/unit/file-operations.test.ts)                         |      12 | writeAll short/zero/error/abort; withFileHandle close; cleanupFailedPreparation и совмещённые причины.                 |
| [find-cli](../tests/unit/find-cli.test.ts)                                       |      22 | Компонент finder: строки/сортировка/скролл/resize, пустой результат, ошибка/retry, отмена и TTY.                       |
| [find-search](../tests/unit/find-search.test.ts)                                 |      10 | Debounce 200 мс, минимальный префикс, abort, устаревшие ответы, retry, close.                                          |
| [frontmatter](../tests/unit/frontmatter.test.ts)                                 |      40 | YAML/frontmatter, строки, обязательные поля, безопасное имя, aliases и их лимит.                                       |
| [installer-events](../tests/unit/installer-events.test.ts)                       |      10 | Условия download/install, общие агенты, metadata-only/no-op, partial/failed, отказ/отмена и локальные источники.       |
| [installer-filesystem](../tests/unit/installer-filesystem.test.ts)               |       6 | Зависимые move/обратный порядок, EXDEV без cp, recovery и cleanup до/после commit.                                     |
| [installer-native-inspection](../tests/unit/installer-native-inspection.test.ts) |       4 | Моделируемые Windows-пути агентов, владение junction и отказ cross-drive до I/O.                                       |
| [installer-plan](../tests/unit/installer-plan.test.ts)                           |       9 | Чистые решения unchanged/metadata-only/apply, reusable и причины preview; текущий путь Pi.                             |
| [installer-source](../tests/unit/installer-source.test.ts)                       |       5 | Выбор folder.tgz/archive/registry, latest/exact и запрет неразрешённой подготовки без HTTP.                            |
| [loading-ui](../tests/unit/loading-ui.test.ts)                                   |      10 | Быстрые операции, задержка/анимация/TTY, смена экрана и освобождение индикатора.                                       |
| [native-path](../tests/unit/native-path.test.ts)                                 |      66 | Нативные/переносимые пути и имена, Unicode/регистр, границы, сериализация и коллизии lock.                             |
| [portable-hash](../tests/unit/portable-hash.test.ts)                             |      11 | Эталон digest, LF/CRLF, Unicode/байтовые имена, гонки чтения и abort/close.                                            |
| [portable-sources](../tests/unit/portable-sources.test.ts)                       |      27 | Подключение политики имён/области к адаптерам, Unicode/short writes и исключаемые пути.                                |
| [registry-client](../tests/unit/registry-client.test.ts)                         |      80 | SemVer/URL, ответы/лимиты, размер/digest, ошибки потока, refresh одной версии и конфиденциальность URL; HTTP подменён. |
| [registry-source-cleanup](../tests/unit/registry-source-cleanup.test.ts)         |       2 | Владение download-workspace, повтор cleanup и сохранение обеих причин отказа.                                          |
| [registry-source](../tests/unit/registry-source.test.ts)                         |       4 | Разрешённый артефакт без повторного latest, slug/version/name mismatch, callback и cleanup.                            |
| [regular-file](../tests/unit/regular-file.test.ts)                               |      16 | Флаги ОС, verified handle, inode/подмена/ссылки, закрытие при ошибке и отмене.                                         |
| [remove-ui](../tests/unit/remove-ui.test.ts)                                     |       9 | Выбор без предвыбора, прокрутка, cancel/decline/approve, фильтр агентов, --yes и результаты.                           |
| [source-cancellation](../tests/unit/source-cancellation.test.ts)                 |      13 | Прерывание папки/архива/хеширования и очистка, сохранение abort вместе с ошибкой close/cleanup.                        |
| [source-file-operations](../tests/unit/source-file-operations.test.ts)           |      10 | Подключение helpers к обоим адаптерам: zero write, размер, закрытие вложенных handles до cleanup.                      |
| [state-io](../tests/unit/state-io.test.ts)                                       |       9 | Verified reads и атомарный store: подмена файла, sync/close, временные файлы и совмещённые ошибки.                     |
| [state-mutex](../tests/unit/state-mutex.test.ts)                                 |       7 | Владение блокировкой, BigInt inode, чужая замена и ошибки освобождения.                                                |
| [state-paths](../tests/unit/state-paths.test.ts)                                 |       9 | Корни областей, home guard, переносимость источников/подключений и идентичность источника.                             |
| [state-schema](../tests/unit/state-schema.test.ts)                               |      22 | Строгий lock: версия/тип/структура, агенты, коллизии, пути и запрет signed URL.                                        |
| [state-store](../tests/unit/state-store.test.ts)                                 |       3 | Атомарная запись: сохранение прежних bytes, cleanup и отсутствие частичной видимой записи.                             |
| [telemetry-client](../tests/unit/telemetry-client.test.ts)                       |      12 | Envelope v1, endpoint override/opt-out, bounded timeout/abort и best-effort ошибки транспорта.                         |
| [terminal-layout](../tests/unit/terminal-layout.test.ts)                         |      10 | Ширина графем, многоточие и сохранение пробелов/разделителей в путях.                                                  |
| [terminal-lifecycle](../tests/unit/terminal-lifecycle.test.ts)                   |      28 | По одному probe каждого UI для EOF/error/render; add ждёт cleanup и завершает одобренную транзакцию.                   |
| [terminal-session](../tests/unit/terminal-session.test.ts)                       |      10 | Общая матрица EOF/close/error/setup, raw/flow, чужие listeners, идемпотентность и releaseInput.                        |
| [test-environment](../tests/unit/test-environment.test.ts)                       |       9 | Изолированные cwd/home/env/npm/tmp, allowlist, subprocess и запрет HTTP по умолчанию.                                  |
| [updates-ui](../tests/unit/updates-ui.test.ts)                                   |      15 | Готовые preview/results: default No, approve/decline/cancel, TTY, pinned/local, причины и диагностика.                 |
| [windows-agent-links](../tests/unit/windows-agent-links.test.ts)                 |       5 | Моделируемая junction: абсолютная цель, владение, unlink/rollback без fallback в copy.                                 |
| [windows-hash](../tests/unit/windows-hash.test.ts)                               |       2 | Моделируемые Windows Unicode/namespace пути без потери имён.                                                           |
| [windows-sources](../tests/unit/windows-sources.test.ts)                         |       1 | Передача нативного Windows extraction-пути после проверки архива.                                                      |

### Интеграции

| Файл                                                                          | Случаев | Что проверяет                                                                                                  |
| ----------------------------------------------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------- |
| [add-cli](../tests/integration/add-cli.test.ts)                               |      10 | Порядок область/агенты/карточка и отмена настоящей подготовки до освобождения ресурсов.                        |
| [add-installer](../tests/integration/add-installer.test.ts)                   |       8 | Callback review, единственный снимок, отказ/отмена, выбранная версия и сохранённые пути.                       |
| [agent-copies](../tests/integration/agent-copies.test.ts)                     |      30 | Общий contentHash двух копий, preview races, staging/commit/rollback, partial нового подключения и recovery.   |
| [agents-installer](../tests/integration/agents-installer.test.ts)             |      21 | Direct/copy/link, объединение/фильтр агентов, env/сохранённые пути, владение и partial.                        |
| [archive-installer](../tests/integration/archive-installer.test.ts)           |       4 | Подключение архива в обеих областях и metadata-only при другом digest тех же файлов.                           |
| [find-install](../tests/integration/find-install.test.ts)                     |       5 | Выбранная версия с политикой latest, агенты/opt-out и отмена до установки.                                     |
| [git-roundtrip](../tests/integration/git-roundtrip.test.ts)                   |       4 | Четыре реальных commit/clone: NFC/NFD × autocrlf; bytes/hash/no-op, attributes/ignore и post-clone работа.     |
| [installer-cancellation](../tests/integration/installer-cancellation.test.ts) |       4 | Force не скрывает отмену; блокировка освобождается после cleanup в обеих областях.                             |
| [installer-hash-policy](../tests/integration/installer-hash-policy.test.ts)   |       2 | Force не скрывает ошибку close; глобальные native POSIX-имена в add/reuse/update.                              |
| [installer-preparation](../tests/integration/installer-preparation.test.ts)   |       2 | Отказ разрешения registry и отказ подготовки сохраняют обе копии/lock и освобождают ресурсы.                   |
| [loading-command](../tests/integration/loading-command.test.ts)               |       1 | Подключение индикатора к update и очистка перед итоговой таблицей.                                             |
| [local-installer](../tests/integration/local-installer.test.ts)               |      42 | Локальное владение/force/no-op, conflicts, list/remove, state commit и межпроцессный writer.                   |
| [registry-http](../tests/integration/registry-http.test.ts)                   |       3 | Настоящий HTTP: зависшие headers/body metadata/download и оборванное тело ответа.                              |
| [registry-installer](../tests/integration/registry-installer.test.ts)         |       9 | Подключение latest/exact, постоянная идентичность, prior edits, transport failure и конфликт источников.       |
| [remove-cli](../tests/integration/remove-cli.test.ts)                         |       3 | Подтверждённые агенты при конкурентном add; продолжение batch после partial и thrown failure.                  |
| [state-concurrency](../tests/integration/state-concurrency.test.ts)           |       4 | StateStore+mutex: fstat failure, конкурирующие области/процессы, stale lock и завершённая транзакция.          |
| [state-git](../tests/integration/state-git.test.ts)                           |       1 | Git ignore/track в корне и вложенном проекте; глубокие ресурсы и служебные файлы.                              |
| [telemetry](../tests/integration/telemetry.test.ts)                           |       4 | Installer действительно вызывает события один раз; commit и digest/archive failure дают правильный результат.  |
| [updates-installer](../tests/integration/updates-installer.test.ts)           |      36 | Сохранённые источники, latest/exact/pin/unpin, no-op/reuse/repair, batches, guards и preview races.            |
| [updates-review](../tests/integration/updates-review.test.ts)                 |       6 | UI+Installer: выбранная версия, decline/next, cancel после успеха, preview edit и cleanup локальных адаптеров. |

### Восемь e2e

Файл: [lifecycle.test.ts](../tests/e2e/lifecycle.test.ts).

| Сценарий                       | Количество | Проверки                                                                                                                                                                                                           |
| ------------------------------ | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registry project/global        |          2 | Find без установки; add/list/repeat; metadata-only pin/unpin без загрузки/событий; update из сохранённого registry; downgrade/exact/skip/unpin; удаление подключения и последнего скилла; обе формы --without-stat |
| Directory project/global       |          2 | Сложные Unicode/cmd-пути; обе копии и binary; изменение источника/update/remove; защита ручных правок Claude и --force в project; исходник сохранён                                                                |
| Archive project/global         |          2 | .tgz/.tar.gz, update изменённого архива, постоянная identity/digest, обе копии и cleanup                                                                                                                           |
| Повреждённая registry-загрузка |          1 | Exit 1, обе прежние копии и lock сохранены, блокировка/workspace освобождены                                                                                                                                       |
| Telemetry HTTP 503             |          1 | Отдельный endpoint действительно получил события; установка/lock/exit остаются успешными                                                                                                                           |

Мок использует fixtures архивов и версий. Формы каталога, карточки, артефакта и событий
соответствуют `ai-tools-core/docs/openapi/swagger.yaml` (SkillCatalogItem, SkillDetail,
SkillArtifact, SkillTelemetryEvent). Настоящий fetch получает только локальные
URL. Мок хранит latest, выдаёт версии 1.0.0/2.0.0 и signed download URL, принимает события v1 и сохраняет
все запросы; неожиданные метод/маршрут/версия/envelope проваливают сценарий. Expected bytes и JSON lock
проверяются без вызова Installer/StateStore. Отсутствие dist проваливает e2e с командой сборки.
Сценарии проверяют CLI с контрактным моком; работоспособность backend и обнаружение
скиллов агентами проверяются отдельно.

## Распределение проверок

Полные матрицы входов и ошибок размещаются у компонента, которому принадлежит правило:

- Валидация путей и имён — native-path и frontmatter; адаптеры проверяют применение этих правил.
- Tar/gzip и ограничения распаковки — archive-source; HTTP и артефакты — registry-client.
- Схема lock, атомарная запись и блокировки — state-schema, state-store и state-mutex.
- Запись, закрытие handles и очистка — file-operations; изменения файлов и откат — installer-filesystem.
- Условия событий — installer-events; доставка — telemetry-client.
- Общий жизненный цикл терминала — terminal-session; меню проверяют собственные переходы и клавиши.

Интеграционные тесты проверяют подключение каждого источника и direct/copy/link,
согласованность двух копий, partial, изменение после preview, откат, отмену до
освобождения блокировки и конкуренцию процессов. Процессные lifecycle-сценарии
собранного CLI проверяются в e2e; CLI-компоненты проверяют аргументы, решения,
вывод и обработку результатов.
