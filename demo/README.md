# Ручная проверка

Выполняй команды из корня `ai-tools-cli`:

```sh
npm run dev -- add ./demo -a codex
npm run dev -- list
node .agents/skills/demo/scripts/check.mjs
npm run dev -- remove demo
```

После установки `list` показывает `demo`, `local`, `codex`, а скрипт выводит
`DEMO_SKILL_OK`. Обычный каталог находится в `.agents/skills/demo`, запись состояния —
в корневом `skills-installer-lock.json`. Codex читает каталог напрямую, ссылки нет.
В новом чате Codex можно попросить: «Проверь скилл demo».

Чтобы проверить защиту правок, после установки измени
`.agents/skills/demo/SKILL.md` и повтори add. Команда вернёт ошибку.
Для замены изменённой копии используй:

```sh
npm run dev -- add ./demo -a codex --force
```

После remove установленный каталог и запись исчезнут. Исходная папка `demo` останется.
Временный рабочий каталог очищается; постоянных tmp/backups нет.
