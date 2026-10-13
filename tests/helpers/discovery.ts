/** Mirrors SkillCatalogItem / SkillDetail in the backend OpenAPI contract. */
export function catalogItem(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'demo',
    name: 'API Contract Checker',
    shortDescription: 'Checks HTTP contracts',
    tags: ['Go', 'backend'],
    currentVersion: '1.2.3',
    publishedAt: '2026-10-13T09:00:00Z',
    downloadCount: 4,
    installCount: 2,
    ...overrides,
  };
}

export function skillDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...catalogItem(),
    longDescription: 'Detailed contract validation for backend services.',
    version: '1.2.3',
    versions: ['1.2.3', '1.0.0'],
    files: [
      {
        path: 'SKILL.md',
        size: 50,
        sha256: 'a'.repeat(64),
        mediaType: 'text/markdown',
        isText: true,
      },
    ],
    skillMd: {
      url: 'https://storage.example.test/SKILL.md?signature=secret',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    ...overrides,
  };
}
