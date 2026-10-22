import type { Readable, Writable } from 'node:stream';
import type { Key } from 'node:readline';

export interface PromptStreams {
  readonly input: Readable & {
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    readonly setRawMode?: (value: boolean) => void;
  };
  readonly output: Writable & {
    readonly isTTY?: boolean;
    readonly columns?: number;
    readonly rows?: number;
  };
}

export interface Choice<Value> {
  readonly value: Value;
  readonly label: string;
  readonly hint?: string;
}

/** Кадр и курсор принадлежат одному диалогу; close пробует все действия освобождения. */
export interface TerminalScreen {
  readonly clear: () => void;
  readonly write: (lines: readonly string[]) => void;
  readonly hideCursor: () => void;
  readonly showCursor: () => void;
  readonly close: (clearFrame?: boolean) => void;
}

export interface PromptController<Value> {
  readonly screen: TerminalScreen;
  readonly closed: boolean;
  readonly finish: (value: Value | null, error?: unknown) => void;
  readonly render: () => void;
}

export interface PromptHandlers<Value> {
  readonly key: (character: string | undefined, key: Key) => void;
  readonly render: () => void;
  readonly start?: () => void;
  readonly cleanup?: readonly (() => void)[];
  readonly settled?: (value: Value | null) => void;
}

export interface SelectOptions<Value> extends PromptStreams {
  readonly message: string;
  readonly options: readonly Choice<Value>[];
  readonly initialValue: Value;
  readonly signal?: AbortSignal;
  readonly confirmation?: 'select' | 'submit';
  readonly summary?: boolean;
}

export interface ConfirmOptions extends PromptStreams {
  readonly message: string;
  readonly active: string;
  readonly inactive: string;
  readonly signal?: AbortSignal;
  readonly summary?: boolean;
  readonly submitOnKey?: boolean;
}

export interface MultiselectOptions<Value> extends PromptStreams {
  readonly message: string;
  readonly options: readonly Choice<Value>[];
  readonly initialValues?: readonly Value[];
  readonly locked?: readonly Choice<Value>[];
  readonly required?: boolean;
  readonly maxItems?: number;
  readonly signal?: AbortSignal;
  readonly search?: boolean;
  readonly context?: readonly string[];
  readonly lockedLabel?: string;
  readonly optionsLabel?: string;
}
