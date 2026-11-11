import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { withFileHandle } from '@/regular-file';

describe('withFileHandle ownership', () => {
  it.each(['success', 'operation', 'close', 'both'] as const)(
    'closes once before returning %s',
    async (failure) => {
      const operationError = new Error('operation'),
        closeError = new Error('close');
      const order: string[] = [];
      const handle = {
        close: vi.fn(async () => {
          order.push('close');
          if (failure === 'close' || failure === 'both') throw closeError;
        }),
      } as unknown as FileHandle;
      const pending = withFileHandle(handle, async (value) => {
        expect(value).toBe(handle);
        order.push('operation');
        if (failure === 'operation' || failure === 'both') throw operationError;
        return 'result';
      });
      if (failure === 'success') await expect(pending).resolves.toBe('result');
      else if (failure === 'both')
        await expect(pending).rejects.toMatchObject({ errors: [operationError, closeError] });
      else
        await expect(pending).rejects.toBe(failure === 'operation' ? operationError : closeError);
      expect(order).toEqual(['operation', 'close']);
      expect(handle.close).toHaveBeenCalledTimes(1);
    },
  );
});
