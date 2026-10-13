import { cancel, confirm, intro, isCancel, log, note, outro } from '@clack/prompts';
import type { UpdateBatch, UpdateDecision, UpdatePreview } from '../installer/local.ts';
import type { PromptStreams } from './agents-prompt.ts';
import type { InstallationScope } from '../installer/types.ts';
import { renderTable } from './table.ts';

export function createUpdatesUi(
  streams: PromptStreams,
  yes = false,
  scope: InstallationScope = 'project',
) {
  const options = { output: streams.output };
  const previews = new Map<string, UpdatePreview>();
  const columns = [
    { title: 'Skill', maximum: 32 },
    { title: 'Current', maximum: 32 },
    { title: 'Latest', maximum: 32 },
    { title: 'Result', maximum: 24 },
    { title: 'Agents', maximum: 52 },
  ];
  const row = (name: string, result: string) => {
    const preview = previews.get(name);
    return [
      name,
      preview ? (preview.currentVersion ?? 'local') : '—',
      preview
        ? preview.status === 'pinned'
          ? 'not checked'
          : (preview.latestVersion ?? 'local')
        : '—',
      result,
      preview?.agents.join(', ') ?? '—',
    ];
  };
  let started = false;
  const start = () => {
    if (!started) {
      intro(`Skill updates · ${scope}`, options);
      started = true;
    }
  };

  const review = async (preview: UpdatePreview): Promise<UpdateDecision> => {
    start();
    previews.set(preview.name, preview);
    const local = preview.sourceKind !== 'registry';
    const status =
      preview.status === 'pinned'
        ? 'Exact version is pinned; update skipped.'
        : preview.status === 'unchanged'
          ? local
            ? 'No changes in the source.'
            : 'No updates available.'
          : preview.reason === 'copy'
            ? 'Installed contents need replacement.'
            : preview.reason === 'connections'
              ? 'Registered connections need repair.'
              : preview.reason === 'artifact'
                ? 'The archive has changed.'
                : local
                  ? 'Updated source contents are available.'
                  : 'A new version is available.';
    if (preview.status !== 'available' || yes) return 'approve';
    renderTable(columns, [row(preview.name, 'Update available')], streams.output);
    log.info(status, options);
    if (!streams.input.isTTY || !streams.output.isTTY)
      throw new Error(
        'Update confirmation requires TTY stdin and stdout; use --yes to approve updates in scripts.',
      );
    const accepted = await confirm({
      message:
        preview.reason === 'connections'
          ? `Repair connections for ${preview.name}?`
          : preview.reason === 'copy'
            ? `Replace installed contents of ${preview.name}?`
            : `Update ${preview.name}${local ? '' : ` (${preview.currentVersion} → ${preview.latestVersion})`}?`,
      initialValue: false,
      active: 'Yes, update',
      inactive: 'No, skip',
      input: streams.input,
      output: streams.output,
    });
    return isCancel(accepted) ? 'cancel' : accepted ? 'approve' : 'decline';
  };

  const finish = (batch: UpdateBatch) => {
    start();
    if (!batch.results.length) {
      note('No matching skills to update.', 'No matching skills', options);
      outro('Nothing to update.', options);
      return;
    }
    const label = (result: UpdateBatch['results'][number]) => {
      if (result.status === 'skipped')
        return result.reason === 'cancelled' ? 'Cancelled' : 'Skipped';
      return {
        success: 'Updated',
        unchanged: 'Up to date',
        pinned: 'Pinned (exact)',
        partial: 'Partial',
        failed: 'Error',
      }[result.status];
    };
    renderTable(
      columns,
      batch.results.map((result) => row(result.name, label(result))),
      streams.output,
    );
    if (batch.results.every((result) => result.status === 'unchanged'))
      log.info(
        [...previews.values()].every((preview) => preview.sourceKind !== 'registry')
          ? 'No changes in the source.'
          : 'No updates available.',
        options,
      );
    if (batch.results.some((result) => result.status === 'pinned'))
      log.info('Pinned exact versions are skipped. Use add <skill> to select latest.', options);
    for (const result of batch.results) {
      if (result.status === 'failed' || result.status === 'partial')
        log.error(`Error ${result.name} (${result.status}): ${result.errors.join('; ')}`, options);
      else if (result.status === 'skipped') {
        if (result.reason === 'cancelled') {
          cancel(`Cancelled before updating ${result.name}.`, options);
          return;
        }
        log.info(`Skipped ${result.name}; update declined.`, options);
      }
    }
    const count = (status: string) =>
      batch.results.filter((result) => result.status === status).length;
    outro(
      `Updated: ${count('success')} · Unchanged: ${count('unchanged')} · Pinned: ${count('pinned')} · Skipped: ${count('skipped')} · Errors: ${count('failed') + count('partial')}`,
      options,
    );
  };
  return { review, finish, report: (message: string) => log.info(message, options) };
}
