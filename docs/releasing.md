# CI и публикация в npm

Пакет собирается и проверяется через npm 11.19.0. Публикация запускается вручную
из GitHub Actions; push, pull request и тег сами по себе её не запускают.
Workflow не повышает версию, не создаёт коммиты, теги или GitHub Release.

## Проверки CI

[ci.yml](../.github/workflows/ci.yml) запускается для pull request и push в `main`
или `codex/windows-support`; доступен также ручной `workflow_dispatch`.
Он также вызывается workflow публикации и проверяет именно коммит выбранного запуска.
Матрица: `ubuntu-latest` / `macos-latest` / `windows-latest` × Node `22.20.0` / `24`
— шесть комбинаций, Windows runner — x64.
Node 22 проверяется на минимальной поддерживаемой версии, Node 24 — на актуальном
патче ветки. npm устанавливается из `packageManager` в `package.json`.
При обновлении `packageManager` синхронизируйте закреплённую версию npm в `publish.yml`.
На Windows используется PowerShell (`pwsh`), на Linux/macOS — стандартная Bash.
Проверка версии из `RELEASE_VERSION` выполняется общим
[Node-скриптом](../scripts/check-release-version.mjs), без shell heredoc.
[.gitattributes](../.gitattributes) закрепляет LF для текстовых файлов репозитория,
включая Windows checkout с `core.autocrlf=true`. Для `.agents/skills/**` и
`.claude/skills/**` преобразование отключено: ресурсы скиллов сохраняют исходные байты.

Для проверки Windows-доработок отправьте проверенный коммит в
`codex/windows-support`: push запустит всю матрицу. После появления workflow
в default branch его также можно запустить через **Actions → CI → Run workflow**,
выбрав нужную ветку. Commit/push выполняются отдельным поручением.
Windows jobs запускают полный набор ниже; пока адаптация CLI и тестов не завершена,
их ошибки показывают оставшиеся несовместимости. Добавление runner не означает
успешного Windows-прогона или завершения нативной приёмки.

На каждой комбинации выполняются:

```sh
npm ci
npm run type-check
npm run lint
npm run format:check
npm run test:run
npm run build
npm run package:check
npm run package:smoke
```

`package:check` запускает publint. `package:smoke` выполняет `npm pack --dry-run --json`
и настоящий `npm pack`, проверяет имя, версию, разрешённый состав, shebang и executable.
Разрешены только `dist/`, `package.json`, README и лицензии; исходники, тесты,
настройки агентов и журналы задач в архив не попадают.

Bin остаётся `dist/cli.mjs`. [Подготовка архива](../scripts/package-archive.mjs)
использует состав от `npm pack --ignore-scripts`, затем перепаковывает tar без
извлечения файлов, добавляя executable-биты только bin. Это обходит ошибку npm
с вложенным bin на Windows без изменения точки входа и прав исходного файла.
Из подготовленного tar npm получает preview/pack JSON и сохраняет финальный архив;
проверки mode в этих метаданных и настоящем tar header сохраняются на каждой ОС.
Для получения проверенного архива используйте `npm run package:smoke`:
прямой `npm pack` исходного каталога не выполняет эту подготовку.

Архив устанавливается с `--omit=dev` в чистый временный проект и отдельный
глобальный npm-prefix. Проверяются настоящий bin, help/version и цикл локального
и глобального add/list/update/remove с Codex и Claude Code. В проекте Claude —
обычная копия, глобально — POSIX symlink / Windows junction. Сверяются bytes и
SHA-256 дерева обеих копий с источником, изменение contentHash при update и удаление.
Executable проверяется также в заголовке настоящего tar на каждой ОС.

Npm вызывается через `process.execPath` и `npm_execpath`, полученный от `npm run`;
проверку запускайте именно `npm run package:smoke`. Установленный POSIX executable
вызывается напрямую, Windows `.cmd` — через `cmd.exe /d /s /v:off` с экранированием
аргументов и второго разбора npm shim. Проверяются локальный `node_modules/.bin`
и глобальный bin (на Windows — прямо в prefix). Каталоги установки содержат пробелы
и кириллицу; рабочий каталог CLI и аргумент источника дополнительно содержат
`&`, скобки, `%PATH%`, `!` и `^`.
Путь самого npm shim исключает эти метасимволы: в npm 11.19 он содержит
незакавыченное `SET dp0=%~dp0` ([npm/cmd-shim#45](https://github.com/npm/cmd-shim/issues/45)).
Локальный пакет устанавливается в отдельный временный проект, а его bin запускается
из рабочего каталога с метасимволами. Глобальный prefix учитывает то же ограничение.
Shim не переписывается и не заменяется вызовом `node dist/cli.mjs`.
Регрессия устанавливает минимальный npm-архив локально/глобально без сети и
проверяет фактические cwd, байты ресурса и аргументы настоящего установленного bin;
на Windows это выполнение npm `.cmd` через cmd, без подмены дочернего процесса.
В PowerShell при запрете `.ps1` используйте `skills-installer.cmd` и `npm.cmd`;
изменение ExecutionPolicy и повышенные права не требуются.

Общий [helper окружения](../scripts/isolated-runtime.mjs) используется тестами и smoke.
Из настоящего env берутся только PATH, SystemRoot/windir, ComSpec и PATHEXT;
имена нормализуются без учёта регистра. HOME/USERPROFILE/HOMEDRIVE/HOMEPATH,
AppData/LocalAppData, TEMP/TMP/TMPDIR, XDG и каталоги агентов принадлежат fixture.
Npm prefix/cache и пустые user/global npmrc тоже временные; изолированные значения
побеждают overrides. Секреты, NODE_OPTIONS/NODE_PATH и остальная npm-конфигурация
не наследуются. Homedir/tmpdir проверяются настоящим дочерним Node, статистика отключена.
Для runtime-зависимостей нужен доступ к npm registry. Собственные корни удаляются
с maxRetries: 3, retryDelay: 100; проверенный архив сохраняется в `artifacts/npm/`.
Эти проверки на macOS не заменяют нативную приёмку Windows/NTFS и PowerShell/cmd.

Из комбинации Linux / Node 24 загружается артефакт `npm-package` со сроком хранения
семь дней. Публикация скачивает его из своего запуска после успеха всей матрицы.
Повторной сборки между проверкой и публикацией нет. Actions закреплены commit SHA;
права обычных проверок — `contents: read`, npm-кеш не используется.

## Однократная настройка перед релизом

Эти действия выполняет владелец репозитория/пакета. Добавление файлов workflow
не создаёт настройки GitHub или npm автоматически.

1. Пакет публикуется как **`@trof_r/skills-installer`** в scope npm-аккаунта `trof_r`.
   Проверьте, что `npm login` выполнен под этим аккаунтом: `npm whoami` должен
   вывести `trof_r`. Команда bin — `skills-installer`. При изменении npm-имени
   синхронизируйте `package-lock.json` и ключи пакета в накопленных Changesets.
2. Для provenance нужны публичные GitHub-репозиторий и npm-пакет.
   `repository.url` указывает на `git+https://github.com/TRK08/ai-tools-cli.git`.
   При переносе репозитория обновите это поле, ограничение `github.repository`
   в `publish.yml` и настройки Trusted Publisher.
3. В GitHub создайте environment **`npm`** и разрешите deployment только из `main`.
   Required reviewers можно добавить, если функция доступна в вашем тарифе.
   В правилах защиты `main` включите обязательные проверки шести комбинаций CI
   после подтверждения их успешных прогонов.
4. В настройках npm-пакета выберите **Trusted Publisher → GitHub Actions**:

   | Поле                 | Значение       |
   | -------------------- | -------------- |
   | Organization or user | `TRK08`        |
   | Repository           | `ai-tools-cli` |
   | Workflow filename    | `publish.yml`  |
   | Environment name     | `npm`          |
   | Allowed actions      | `npm publish`  |

   Filename задаётся без `.github/workflows/`. Публикация выполняется в job самого
   `publish.yml`; вызываемый `ci.yml` только проверяет пакет.
   Organization or user — GitHub-владелец `TRK08`; npm scope пакета — `trof_r`.
   Выберите разрешение прямой публикации `npm publish`, если интерфейс npm предлагает
   разделение прямой и staged publication. Секрет `NPM_TOKEN` / `NODE_AUTH_TOKEN`
   для этого workflow не нужен: npm получает краткоживущую авторизацию через OIDC.
   `id-token: write` выдан только job публикации.

Trusted Publishing требует npm ≥11.5.1 и Node ≥22.14; используемые версии подходят.
Подробности и актуальные поля настройки — в [документации npm](https://docs.npmjs.com/trusted-publishers/).

Если пакет ещё не существует, сначала нужна отдельная первичная публикация владельцем:
настройки Trusted Publisher находятся на странице уже существующего пакета.
Соберите и проверьте архив описанными выше командами, затем авторизуйтесь через
`npm login` под аккаунтом `trof_r` и опубликуйте именно проверенный `.tgz`.
Для текущей версии `0.1.0` команда:

```sh
npm publish ./artifacts/npm/trof_r-skills-installer-0.1.0.tgz --access public --ignore-scripts
```

Это отдельное внешнее действие, которое данный CI не выполняет. После него
настройте Trusted Publisher и готовьте следующую версию через workflow.

## Подготовка версии

Для изменений добавляйте заметку Changesets:

```sh
npm run changeset
```

Перед релизом в отдельной рабочей ветке примените накопленные заметки и синхронизируйте lock:

```sh
npm run changeset -- version
npm install --package-lock-only --ignore-scripts
npm ci
```

Проверьте `package.json`, `package-lock.json` и `CHANGELOG.md`, затем выполните весь
набор проверок CI. Релизный коммит с новой версией должен пройти ревью и попасть в `main`.
Подготовка версии и merge выполняются отдельно от workflow публикации.

## Ручной запуск публикации

1. Откройте **Actions → Publish npm → Run workflow** в `TRK08/ai-tools-cli`.
2. Выберите ветку **`main`** и введите `version`, совпадающую с `package.json`
   выбранного коммита, например `0.1.1`. Поддерживается стабильная SemVer `X.Y.Z`;
   prerelease и другие dist-tags требуют отдельного изменения workflow.
3. Workflow снова запускает полную CI-матрицу. Несовпадение версии или ошибка
   любой проверки останавливает публикацию. Запуск из другой ветки или форка
   пропускает релизные jobs.
4. После проверок job `publish` входит в environment `npm`. Если настроены
   required reviewers, одобрите deployment в GitHub. Он публикует проверенный
   архив с `--access public --tag latest --provenance --ignore-scripts`.
5. После успеха проверьте страницу пакета, версию и provenance. Для независимой
   проверки registry выполните `npm view @trof_r/skills-installer@0.1.1 version dist.integrity`
   и проверьте `npx --yes @trof_r/skills-installer@0.1.1 --version` в отдельном каталоге.
   Подставьте фактическую версию.

Запуски публикации сериализованы через `concurrency: publish-npm`; новый запуск
не отменяет текущий. Выполняется снимок `main` на момент запуска — последующие
коммиты не меняют публикуемый архив. Проверки обычного PR могут отменяться новым
запуском того же PR, релизные проверки не отменяются автоматически.

## Ошибки и повторный запуск

- При падении CI исправьте причину и подготовьте новый запуск для нужного коммита.
- `E404`/ошибка авторизации при publish: проверьте владение npm-именем и точное
  совпадение owner/repository/filename/environment в Trusted Publisher,
  разрешение `npm publish`, `repository.url` и публичность репозитория для provenance.
  npm не проверяет корректность Trusted Publisher при сохранении настройки.
- Если версия уже опубликована, повторно опубликовать её нельзя. Сначала проверьте
  registry: публикация могла успеть завершиться до ошибки job. Для изменения
  содержимого подготовьте новую версию через Changesets.
- Если артефакт уже удалён по сроку хранения, запускайте весь workflow заново,
  чтобы заново выполнить проверки и собрать архив того же выбранного коммита.

CI и проверка архивов подтверждают автоматизированные сценарии. Обнаружение скиллов
пятью реальными агентами и остальная ручная итоговая матрица MVP проверяются отдельно;
успешный workflow не заменяет эти проверки и пользовательский аппрув результата.
