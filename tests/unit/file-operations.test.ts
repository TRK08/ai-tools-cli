import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { withFileHandle, writeAll } from '../../src/regular-file.ts';
import { cleanupFailedPreparation, OWNED_WORKSPACE_CLEANUP } from '../../src/sources/filesystem.ts';

describe('writeAll', () => {
  it('writes every byte across short writes without closing the borrowed handle', async () => {
    const chunks: Buffer[] = [];
    const write = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesWritten = Math.min(length, 2);
      chunks.push(buffer.subarray(offset, offset + bytesWritten));
      return { buffer, bytesWritten };
    });
    const close = vi.fn();
    const handle = { write: write as unknown as FileHandle['write'], close };
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    await writeAll(handle, bytes, 'zero');
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(write.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([
      [0, 5],
      [2, 3],
      [4, 1],
    ]);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(['zero', 'error', 'abort-before', 'abort-during'] as const)(
    'stops without retry after %s',
    async (failure) => {
      const controller = new AbortController();
      const cause = new Error(failure);
      const write = vi.fn(async (buffer: Buffer) => {
        if (failure === 'error') throw cause;
        if (failure === 'abort-during') controller.abort(cause);
        return { buffer, bytesWritten: failure === 'zero' ? 0 : 1 };
      });
      if (failure === 'abort-before') controller.abort(cause);
      const handle = { write: write as unknown as FileHandle['write'] };
      const pending = writeAll(handle, Buffer.from('abc'), 'zero write', controller.signal);
      if (failure === 'zero') await expect(pending).rejects.toThrow('zero write');
      else await expect(pending).rejects.toBe(cause);
      expect(write).toHaveBeenCalledTimes(failure === 'abort-before' ? 0 : 1);
    },
  );
});

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

describe('failed preparation cleanup', () => {
  it.each([undefined, '/owned/workspace'])(
    'preserves the original reason after cleanup of %s',
    async (workspace) => {
      const cause = new Error('abort or preparation');
      const rm = vi.fn(async () => {}),
        wrap = vi.fn((cause: AggregateError) => new Error('cleanup', { cause }));
      await expect(cleanupFailedPreparation(workspace, cause, { rm }, wrap)).rejects.toBe(cause);
      expect(rm.mock.calls).toEqual(workspace ? [[workspace, OWNED_WORKSPACE_CLEANUP]] : []);
      expect(wrap).not.toHaveBeenCalled();
    },
  );
  it('retains preparation and cleanup failures with the adapter recovery diagnostic', async () => {
    const cause = new Error('preparation'),
      cleanup = new Error('remove');
    const rm = vi.fn(async () => {
      throw cleanup;
    });
    const pending = cleanupFailedPreparation(
      '/owned/workspace',
      cause,
      { rm },
      (cause) => new Error('recovery: /owned/workspace', { cause }),
    );
    await expect(pending).rejects.toMatchObject({
      message: 'recovery: /owned/workspace',
      cause: { errors: [cause, cleanup] },
    });
    expect(rm).toHaveBeenCalledTimes(1);
  });
});
