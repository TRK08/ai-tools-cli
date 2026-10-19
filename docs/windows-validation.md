# Windows: проверенные среды и оставшаяся приёмка

Дата: 2026-10-19. Реализация задачи 019 после `01ec12e` передана для проверки в CI.
Windows x64/локальный NTFS — целевая платформа; окончательная приёмка ещё не завершена.
UNC/SMB, OneDrive, Windows ARM64 и case-sensitive NTFS в первую матрицу не входят.
Node.js ≥22.20.0, npm 11.19.0; базовые версии CI — 22.20.0 и 24.

## Автоматические проверки

Для `01ec12e` обе предыдущие матрицы
([push](https://github.com/TRK08/ai-tools-cli/actions/runs/39316692072),
[PR](https://github.com/TRK08/ai-tools-cli/actions/runs/39316698407)) прошли все
шесть комбинаций. На Windows прошли настоящий local/global `.cmd`, сложные
cwd/source-аргументы и executable-mode npm metadata/tar. Это evidence 018,
оно не является запуском новых Git jobs рабочей версии 019.

| Среда рабочей версии 019                   | Результат                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| macOS arm64, Node 24.21.0                  | type-check/lint/format, 1029 passed / 2 прежних skipped, build/package:check/package:smoke; 8 Git checkout-сценариев |
| Linux Docker arm64, Node 24.21.0 / 22.20.0 | npm ci и все общие проверки прошли на обеих Node; 1031 passed без skipped на каждой; по 8 Git checkout-сценариев     |
| Windows hosted, Node 22.20/24              | Ожидается новый CI после отправки; результат этой ревизии ещё не получен                                             |
| Все 9 Git-направлений на двух Node         | CI jobs настроены; полный межплатформенный прогон ещё не выполнен                                                    |

Git fixtures включают LF/CRLF/mixed endings, binary, hidden и глубокие ignored
ресурсы, отдельные NFC/NFD-имена, executable и пустую папку. Consumer сверяет
bytes обеих обычных копий и текущий contentHash, no-op без переписывания,
ручные правки каждой копии, force, list/remove без внешнего source и неизменность
Vercel `skills-lock.json`. Коллизии NFC/регистра отклоняются тестами источников;
совместно коллидирующие имена не используются как успешный fixture.

Локально пройдены 24 checkout-сценария: bundles macOS/Linux, consumers macOS на
Node 24 и Linux на Node 22.20/24; NFC/NFD × два autocrlf. Это реальные Linux
контейнеры с отдельной временной копией проекта, без монтирования настоящего home.
Consumer CLI требует полный набор трёх ОС в CI; для локальной неполной
матрицы вызван экспорт `consumeGitBundles` с явными producers linux/darwin.
macOS/Node 22.20 и Windows-направления этой рабочей ревизии ещё не проверены.
Workflow и composite action проверены actionlint 1.7.12; `git diff --check` прошёл.

## Обнаружение реальными агентами после Git clone

На macOS использован настоящий bundle/clone и временные HOME/XDG/CODEX_HOME,
без пользовательских credentials, без model turns и без указания агентам пути
скилла через явный `--skill` или дополнительный skills.paths.

| Агент               | Проверка                                     | Результат                                                 |
| ------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Codex 0.162.1       | Локальный app-server `skills/list`           | `git-roundtrip` найден в `.agents/skills` и enabled       |
| OpenCode 1.17.9     | `opencode debug skill`                       | `git-roundtrip` найден в `.agents/skills`                 |
| Pi 0.87.0           | RPC `get_commands`, offline/no-session       | Автоматически найден `skill:git-roundtrip`, scope project |
| Claude Code         | CLI здесь отсутствует                        | Не проверено                                              |
| Cursor              | CLI/приложение для проверки здесь недоступны | Не проверено                                              |
| Все пять на Windows | Требуется отдельная Windows-среда            | Не проверено                                              |

Наличие папки или успешный Installer-тест само по себе не считается обнаружением.

## Нативная приёмка обычным Windows-пользователем

Hosted runner может иметь повышенные права или Developer Mode. Его успех не
подтверждает следующие сценарии без администратора/Developer Mode:

| Проверки                                                                                | Состояние                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| PowerShell и cmd, local/global npm, Node 22.20 и 24                                     | Требуется нативный прогон обычной учётной записью |
| Все источники/агенты; только Claude и mixed; exact/latest/force/repeat/manual edits     | Требуется нативный прогон                         |
| Пробелы/кириллица, long path, другой диск глобального CLAUDE_CONFIG_DIR                 | Требуется нативный прогон                         |
| Junction create/check/remove/undo, mutex, fsync/rename, busy/read-only files и recovery | Требуется нативный прогон                         |
| Стрелки/Enter/Backspace/Delete/Esc/Ctrl+C, resize/Unicode, NO_COLOR/FORCE_COLOR, pipe   | Требуется нативный PTY/терминал                   |
| Обнаружение Claude/Codex/OpenCode/Cursor/Pi                                             | Требуется нативный прогон каждого агента          |

Для каждой строки сохранить дату, ОС/версию Node/агента, обычную учётную запись,
команду/сценарий и фактический результат в изолированной конфигурации. Пропуск
не превращается в passed. Эти проверки остаются в объёме 019 до выполнения или
явного согласования пользователем исключений; Windows готовой не объявляется.
