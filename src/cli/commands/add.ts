import { parseAgents } from '../../agents/resolve.ts';
import { Installer } from '../../installer/installer.ts';
import type { RegistrySelection } from '../../installer/types.ts';
import { Telemetry } from '../../telemetry/client.ts';
import { selectAgents, selectScope } from './selection.ts';
import { createAddUi } from '../ui/add-ui.ts';
import { RegistryClient } from '../../registry/client.ts';
import { addCardView } from './add-card.ts';
import { failureLabel } from '../ui/labels.ts';
import { promptStreams } from '../context.ts';
import type { AddOptions, CliContext } from '../types.ts';

/** Выполняет общий add/find; до I/O проверяет параметры, после операции ждёт flush и очистку UI. */
export async function addSkill(
  context: CliContext,
  source: string,
  options: AddOptions,
  reference?: RegistrySelection,
): Promise<void> {
  const streams = promptStreams(context);
  parseAgents(options.agent);
  const scope = await selectScope(options.global, context.runtime, streams);
  if (scope === null) {
    context.stdout.write('Отменено.\n');
    return;
  }
  const agents = await selectAgents(options.agent, context.runtime, scope, streams);
  if (agents === null) {
    context.stdout.write('Отменено.\n');
    return;
  }
  if ((!streams.input.isTTY || !streams.output.isTTY) && !options.yes)
    throw new Error(
      'Для подтверждения установки нужны stdin и stdout терминала (TTY); в скриптах используйте --yes.',
    );
  const ui = createAddUi(streams, options.yes);
  const telemetry = new Telemetry(context.runtime, context.version, {
    disabled: !!options.withoutStat,
  });
  const target = new Installer(context.runtime, {
    scope,
    report: ui.report,
    telemetry,
    /** Загружает выбранную карточку внутри ui.run; отмена ждёт освобождения Installer и терминала. */
    reviewAdd: async (preview) => {
      let details;
      try {
        if (preview.source.kind === 'registry')
          details = await new RegistryClient(
            preview.source.registryUrl,
            context.runtime.http,
          ).getSkill(preview.source.slug, preview.version!, ui.signal);
      } catch (cause) {
        if (ui.signal.aborted) return 'cancel';
        throw cause;
      }
      return ui.review(addCardView(preview, details));
    },
    signal: ui.signal,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const result = await ui
    .run(() =>
      reference
        ? target.addRegistry(reference, options.force, agents)
        : target.add(source, options.force, agents),
    )
    .finally(() => telemetry.flush());
  if (result.status === 'skipped') {
    context.stdout.write(result.reason === 'cancelled' ? 'Отменено.\n' : 'Установка отклонена.\n');
    return;
  }
  if (result.status !== 'failed')
    context.stdout.write(
      result.status === 'partial'
        ? `Частично установлен ${result.name}.\n`
        : `${result.status === 'unchanged' ? 'Без изменений' : 'Установлен'} ${result.name} (${agents.join(', ')}).\n`,
    );
  if (result.status === 'partial' || result.status === 'failed')
    throw new Error(`${failureLabel(result.status)}: ${result.errors.join('; ')}`);
}
