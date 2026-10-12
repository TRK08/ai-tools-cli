# skills-installer

CLI для установки и управления скиллами AI-агентов. Рабочая папка — `ai-tools-cli`,
один npm-пакет на TypeScript/ESM для macOS и Linux, Node.js >=22.20.0.

В задаче 001 подготовлен каркас: `--help`, `--version` и инструменты разработки.
Команды `add`, `update`, `remove`, `list`, `restore`, `search`, `info` появятся в
следующих задачах. Сейчас они, как и `install`, завершаются ошибкой с кодом 1.

В задаче 002 реализован внутренний модуль [State](docs/state.md): переносимый lock,
пути двух областей, атомарная запись, исключение конкурентных писателей и SHA-256
содержимого. Модуль проверяется на временных корнях; CLI-команды подключаются позже.

В задаче 003 реализована внутренняя [подготовка локальной папки](docs/sources.md):
проверка YAML, копирование ресурсов с разыменованием ссылок, contentHash готового
снимка и очистка. Первый цикл `add`/`list`/`remove` для Codex относится к задаче 004.

## Разработка

Используйте поддерживаемую чётную ветку Node: 22.20+ или 24.11+; npm зафиксирован
как `11.19.0` в `packageManager`. Требования сборщика отдельно от требований
готового CLI: [tsdown](https://tsdown.dev/guide/getting-started).

```sh
npm ci
npm run dev -- --help
npm run dev -- --version
npm run build
node dist/cli.mjs --help
```

`dev` запускает исходники через [загрузчик tsx](https://tsx.is/dev-api/) (`node --import tsx`), без отдельного
IPC-сокета tsx CLI; это работает и с длинным временным путём на macOS.
Аргументы CLI передаются script после `--`. Для изменения зависимостей используйте
`npm install --save-exact` и сохраняйте `package-lock.json`. Runtime-зависимости
Commander, Clack, yaml и tar находятся в `dependencies`; инструменты сборки,
проверок и разработки — в `devDependencies`.

## Проверки

```sh
npm run type-check
npm run lint
npm run format:check
npm run test:run
npm run build
npm run package:check
```

Проверочные scripts не исправляют файлы. `npm run format` применяет форматирование
отдельно; `npm run test` запускает Vitest в режиме watch. `package:check` требует
предварительной сборки.

Тесты используют временные home/cwd/env, очищают их в `finally` и запрещают HTTP
по умолчанию. Дочерние процессы CLI получают то же изолированное окружение.
Реальные установки агентов не используются. Границы модулей и внутренние контракты
описаны в [docs/architecture.md](docs/architecture.md).

## Упаковка и изменения

```sh
npm run build
npm run package:check
npm pack --dry-run
```

Bin `skills-installer` указывает на `dist/cli.mjs` с shebang. В пакет входят только
`dist`, README и лицензионные файлы (а также обязательный `package.json`). Версия
встраивается из манифеста при сборке. Запуск готового CLI не требует исходников,
TypeScript или tsx; внешние зависимости устанавливаются npm из `dependencies`.
Выполнять build на машине разработчика, а не через install/prepare hook у потребителя.

`npm run changeset` добавляет заметку об изменениях. Повышение версии, changelog,
установка настоящего npm-архива и итоговая платформенная матрица относятся к задаче 011. Автоматических релизных hooks и scripts публикации нет. Публикация npm, push
и настройка remote требуют отдельного поручения.

Порядок задач и пользовательских аппрувов — в [docs/tasks/README.md](docs/tasks/README.md).

## Лицензии

Лицензия проекта — [MIT](LICENSE). Уведомление об адаптированных тестовых помощниках
из соседнего форка `../skills` сохранено в [ThirdPartyNoticeText.txt](ThirdPartyNoticeText.txt).
Соседние проекты не изменяются; обработчики их CLI не перенесены.
