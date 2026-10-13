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

## Пять агентов и меню

```sh
npm run dev -- add ./demo -a claude-code -a codex -a opencode -a pi -a cursor
npm run dev -- list -a pi
npm run dev -- remove demo -a codex
npm run dev -- list
npm run dev -- remove demo
```

Общая копия одна. Codex/OpenCode/Cursor читают её напрямую; Claude Code и Pi
подключены относительными ссылками `.claude/skills/demo` и `.pi/skills/demo`.
Снятие Codex из записи не удаляет общую копию и не скрывает её от Codex, пока
остаются другие агенты. Последний remove удаляет копию и оставшиеся ссылки.

В обычном терминале запусти `npm run dev -- add ./demo` без `-a`. Claude Code,
OpenCode и Codex отмечены. Сними отметки пробелом, перемещаясь стрелками, и выбери
Pi; Enter установит возвращённый выбор. Повторный запуск с другими отметками
добавит подключения, сохранив прежние. Пустой выбор подтвердить нельзя.
Escape/Ctrl+C отменяет команду с кодом 0 без получения источника и записи lock.
Без TTY укажи `-a`; `--force` не отключает меню.

`-g` добавляется к add/list/remove для независимой глобальной области. Чтобы
проверить её без изменения своих установок, используй временные cwd и home,
а также временные `CLAUDE_CONFIG_DIR` и `XDG_CONFIG_HOME`; команду сборки запускай
по абсолютному пути. Автоматические проверки уже используют такие корни.
