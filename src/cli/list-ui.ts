import { intro, note, outro } from '@clack/prompts';
import type { AgentId, InstallationScope } from '../installer/types.ts';
import type { InstallationRecord } from '../state/types.ts';
import type { PromptStreams } from './agents-prompt.ts';
import { renderTable } from './table.ts';

export function renderSkillList(
  records: readonly InstallationRecord[],
  scope: InstallationScope,
  agents: readonly AgentId[],
  streams: PromptStreams,
): void {
  const options = { output: streams.output };
  intro(
    `Installed skills · ${scope}${agents.length ? ` · filter: ${agents.join(', ')}` : ''}`,
    options,
  );
  if (!records.length) {
    note(
      agents.length
        ? `No skills match the selected agents in ${scope === 'project' ? 'this project' : 'global scope'}.`
        : `No skills installed in ${scope === 'project' ? 'this project' : 'global scope'}.`,
      'No skills',
      options,
    );
    outro('0 skills.', options);
    return;
  }
  renderTable(
    [
      { title: 'Skill', maximum: 32 },
      { title: 'Version', maximum: 32 },
      { title: 'Policy', maximum: 8 },
      { title: 'Agents', maximum: 52 },
    ],
    records.map((record) => [
      record.name,
      record.version ?? 'local',
      record.policy,
      record.agents.join(', '),
    ]),
    streams.output,
  );
  const connections = records.reduce((total, record) => total + record.connections.length, 0);
  outro(
    `${records.length} ${records.length === 1 ? 'skill' : 'skills'} · ${connections} ${connections === 1 ? 'connection' : 'connections'}.`,
    options,
  );
}
