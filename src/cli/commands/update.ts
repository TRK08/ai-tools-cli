import { parseAgents } from '@/agents';
import { Installer } from '@/installer';
import { Telemetry } from '@/telemetry';
import { createUpdatesUi } from '@/cli/ui/updates-ui';
import { promptStreams, scopeOf } from '@/cli/context';
import type { CliContext, UpdateOptions } from '@/cli/types';

/** Обновляет пакет, показывает частичные результаты и ждёт телеметрию даже при ошибке. */
export async function updateSkills(
  context: CliContext,
  name: string | undefined,
  options: UpdateOptions,
): Promise<void> {
  const streams = promptStreams(context);
  const ui = createUpdatesUi(streams, scopeOf(options));
  const telemetry = new Telemetry(context.runtime, context.version, {
    disabled: !!options.withoutStat,
  });
  const result = await ui
    .run(() =>
      new Installer(context.runtime, {
        scope: scopeOf(options),
        report: ui.report,
        reviewUpdate: async (preview) => {
          const ask = preview.status === 'available' && !options.yes;
          ui.preview(preview, ask);
          if (!ask) return 'approve';
          if (!streams.input.isTTY || !streams.output.isTTY)
            throw new Error(
              'Для подтверждения обновления нужны stdin и stdout терминала (TTY); в скриптах используйте --yes.',
            );
          return ui.review(preview);
        },
        telemetry,
      }).update(name, options.force, parseAgents(options.agent)),
    )
    .finally(() => telemetry.flush());
  ui.finish(result);
  if (result.status === 'failed')
    throw new Error('Не удалось обновить один или несколько скиллов.');
}
