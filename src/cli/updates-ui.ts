import { cancel, confirm, intro, isCancel, log, note, outro } from '@clack/prompts';
import type { UpdateBatch, UpdateDecision, UpdatePreview } from '../installer/local.ts';
import type { PromptStreams } from './agents-prompt.ts';

export function createUpdatesUi(streams: PromptStreams, yes = false) {
  const options = { output: streams.output };
  let started = false;
  const start = () => {
    if (!started) {
      intro('Skill updates', options);
      started = true;
    }
  };

  const review = async (preview: UpdatePreview): Promise<UpdateDecision> => {
    start();
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
    note(
      [
        `Current version:  ${preview.currentVersion ?? 'Local source'}`,
        `Latest version:   ${local ? 'Not versioned (local source)' : (preview.latestVersion ?? 'Not checked (exact)')}`,
        `Scope:            ${preview.scope}`,
        `Affected agents:  ${preview.agents.join(', ')}`,
        '',
        status,
        ...(preview.status === 'pinned' ? [`Use add ${preview.name} to select latest.`] : []),
      ].join('\n'),
      `${preview.name} · ${preview.status === 'unchanged' ? 'Up to date' : preview.status === 'pinned' ? 'Pinned' : 'Update available'}`,
      options,
    );
    if (preview.status !== 'available' || yes) return 'approve';
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
    for (const result of batch.results) {
      if (result.status === 'success') log.success(`Updated ${result.name}.`, options);
      else if (result.status === 'failed' || result.status === 'partial')
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
