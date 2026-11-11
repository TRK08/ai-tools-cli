import { readRegistryConfig, writeRegistryConfig } from '@/config';
import type { CliContext } from '@/cli/types';

/** Меняет или читает сохранённую настройку без обращения к HTTP и установленным пакетам. */
export async function configureRegistry(
  context: CliContext,
  action: 'get' | 'set' | 'unset',
  key: string,
  value?: string,
): Promise<void> {
  if (key !== 'registry') throw new Error('Доступная настройка: registry.');
  if (action === 'get') {
    context.stdout.write(
      `${(await readRegistryConfig(context.runtime.roots)) ?? 'Реестр не настроен. Выполните skills-installer config set registry https://registry.example'}\n`,
    );
    return;
  }
  await writeRegistryConfig(
    context.runtime.roots,
    action === 'set' ? value : undefined,
    context.runtime.signal,
  );
  context.stdout.write(
    action === 'set' ? 'Настройка registry сохранена.\n' : 'Настройка registry удалена.\n',
  );
}
