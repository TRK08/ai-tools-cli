import type { InstallationScope } from '@/runtime';
import type { AgentId } from '@/agents';
import type { CatalogSkill } from '@/registry';
import type { InstalledSkill, ManagedConnection } from '@/state';

export interface SkillPreview {
  readonly name: string;
  readonly action: 'add' | 'update' | 'remove' | 'disconnect';
  readonly agents: readonly AgentId[];
  readonly modifiedPaths: readonly string[];
}

export interface PackagePreview {
  readonly slug: string;
  readonly previousVersion?: string;
  readonly version: string;
  readonly scope: InstallationScope;
  readonly skills: readonly SkillPreview[];
}

export type Decision = 'approve' | 'decline' | 'cancel';
export type PackageResult = 'success' | 'unchanged' | 'declined' | 'cancelled';

export interface UpdateFailure {
  readonly slug: string;
  readonly error: string;
}

export interface UpdateResult {
  readonly updated: readonly string[];
  readonly failures: readonly UpdateFailure[];
  readonly cancelled: boolean;
}

export interface PathSnapshot {
  readonly identity: string;
  readonly contentHash?: string;
}

export interface SkillSnapshot {
  readonly shared: PathSnapshot | null;
  readonly destinations: readonly {
    readonly connection: ManagedConnection;
    readonly snapshot: PathSnapshot | null;
  }[];
}

export type SkillPlan = { readonly snapshot: SkillSnapshot } & (
  | {
      readonly kind: 'install';
      readonly before: InstalledSkill | undefined;
      readonly after: Omit<InstalledSkill, 'contentHash'>;
      readonly component: CatalogSkill;
      readonly download: boolean;
    }
  | {
      readonly kind: 'remove';
      readonly before: InstalledSkill;
      readonly after: InstalledSkill | undefined;
    }
);
