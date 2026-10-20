# CI и публикация в npm

Пакет собирается и проверяется через npm 11.19.0. Публикация запускается вручную
из GitHub Actions; push, pull request и тег сами по себе её не запускают.
Workflow не повышает версию, не создаёт коммиты, теги или GitHub Release.

## Проверки CI

[ci.yml](../.github/workflows/ci.yml) запускается для pull request и push в `main`
или `codex/windows-support`; доступен также ручной `workflow_dispatch`.
Workflow публикации вызывает тот же reusable CI для выбранного коммита.

Всего семь jobs:

- `prepare` на Ubuntu/Node 24 проверяет release-version, типы, lint, форматирование,
  собирает CLI, запускает publint и один раз выполняет обычный `npm pack --ignore-scripts`.
- `check` на Linux/macOS/Windows × Node 22.20.0/24 собирает CLI, выполняет весь Vitest,
  скачивает общий архив и запускает `npm run package:smoke -- artifacts/npm/package.tgz`.

Общий [setup-cli](../.github/actions/setup-cli/action.yml) устанавливает Node,
npm из `packageManager` и зависимости через `npm ci`. На Windows используется
PowerShell (`pwsh`), на Linux/macOS — Bash. При обновлении `packageManager`
синхронизируйте закреплённую версию npm в `publish.yml`.
Release-version проверяется после установки зависимостей, до сборки и упаковки,
через `node --import tsx scripts/check-release-version.ts`. Ошибка версии
не позволяет создать артефакт и запустить матрицу.

`prepare` сохраняет один tgz в artifact `npm-package` под именем `package.tgz`
на семь дней. Переименование сохраняет bytes архива. Все шесть комбинаций
устанавливают этот же файл; упаковка на Windows/macOS и перепаковка tar отсутствуют.
Успех загрузки артефакта ещё не означает успех проверок. Reusable CI завершается
после всей матрицы, поэтому publish ждёт все семь jobs и публикует проверенный
архив своего запуска без повторной сборки. Actions закреплены commit SHA;
права обычных проверок — `contents: read`, npm-кеш не используется.

### Git и функциональные тесты

Git roundtrip — обычный [Vitest-тест](../tests/git-roundtrip.test.ts).
На каждой ОС проверяются четыре сценария NFC/NFD × core.autocrlf=false/true,
core.symlinks=false, обе проектные копии, bytes/hash, ignore/attributes,
no-op без переписывания, ручные правки/force и работа CLI без внешнего source.
Настоящие commit/clone ограничены временными репозиториями; Git config/hooks,
автор и home изолированы. Межплатформенных bundles и producer/consumer jobs нет.

```sh
npm run test:run
npm run test:git
```

`test:git` — алиас фильтра Vitest для Git-тестов, без produce/consume и без
предварительного build. CLI/Installer-тесты проверяют полный add/list/update/remove,
обе области, агентов, сложные cwd/source и буквальную передачу аргументов через Node.
[.gitattributes](../.gitattributes) закрепляет LF для кода; ресурсы `.agents/skills/**`
и `.claude/skills/**` сохраняют исходные bytes.

### Проверка готового npm-архива

```sh
npm run package:smoke -- /absolute/path/package.tgz
```

[Smoke](../scripts/check-package.ts) не создаёт архив. Он проверяет его состав,
имя/версию, объявленный bin, shebang и executable-mode непосредственно в tar.
Разрешены `dist/`, package.json, README и лицензии; исходники, тесты и настройки
агентов в пакет не попадают. В Linux сборщик выставляет executable-mode bin;
обычный `npm pack` сохраняет его. Для локального создания архива на Linux:

```sh
npm run build
npm run package:check
npm pack --ignore-scripts
npm run package:smoke -- ./trof_r-skills-installer-0.2.0.tgz
```

Smoke устанавливает готовый пакет с `--omit=dev` в чистый временный проект
и отдельный глобальный prefix. Настоящие POSIX executable или Windows `.cmd`
запускаются с фиксированными --help/--version; проверяются версия, справка
и отсутствие devDependencies. Полный lifecycle через npm shim не выполняется.
Пути smoke могут содержать пробелы и кириллицу; путь самого Windows shim
не содержит метасимволов cmd из-за ограничения [npm/cmd-shim#45](https://github.com/npm/cmd-shim/issues/45).
Произвольные аргументы cmd не экранируются универсальным runner.
В PowerShell при запрете `.ps1` используйте `skills-installer.cmd` и `npm.cmd`;
изменение ExecutionPolicy и повышенные права не требуются.

Npm запускается тем же Node через npm_execpath, полученный от `npm run`.
Общий [helper окружения](../scripts/isolated-runtime.ts) изолирует home/tmp/npmrc,
cache/prefix, XDG и профили агентов. Унаследованы только системные ключи;
секреты, NODE_OPTIONS/NODE_PATH и пользовательские npm-настройки не передаются.
Для runtime-зависимостей нужен доступ к npm registry. Собственные временные
ресурсы удаляются с ограниченными retry; входной tgz сохраняется без изменений.

Эти автоматические проверки не заменяют приёмку Windows обычным пользователем
и обнаружение реальными агентами. Факты и ограничения — в [матрице](windows-validation.md).
Commit/push для запуска нового CI выполняются по отдельному поручению.

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
