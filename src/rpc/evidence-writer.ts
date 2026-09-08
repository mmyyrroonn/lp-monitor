import { appendFile, mkdir, stat, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { RpcFailure } from './errors.js';
export type EvidenceMode = 'full' | 'sampled' | 'off';
export interface EvidenceOptions {
  evidenceFile?: string;
  evidenceMode?: EvidenceMode;
  evidenceMaxBytes?: number;
  evidenceMaxFiles?: number;
  evidenceSampleEvery?: number;
}
export class EvidenceWriter {
  private tail: Promise<void> = Promise.resolve();
  private failure: RpcFailure | undefined;
  private closed = false;
  private count = 0;
  private bytes: number | undefined;
  private files = 1;
  private readonly mode: EvidenceMode;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly sampleEvery: number;
  constructor(private readonly options: EvidenceOptions) {
    this.mode = options.evidenceMode ?? 'full';
    this.maxBytes = options.evidenceMaxBytes ?? 16 * 1024 * 1024;
    this.maxFiles = options.evidenceMaxFiles ?? 8;
    this.sampleEvery = options.evidenceSampleEvery ?? 100;
    for (const n of [this.maxBytes, this.maxFiles, this.sampleEvery])
      if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('Invalid evidence settings');
  }
  async write(entry: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new RpcFailure('evidence-closed');
    if (this.failure) throw this.failure;
    if (!this.options.evidenceFile || this.mode === 'off') return;
    let saved = entry;
    if (this.mode === 'sampled' && 'result' in entry && this.count++ % this.sampleEvery !== 0) {
      const { result, ...metadata } = entry;
      saved = {
        ...metadata,
        resultHash: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
      };
    }
    const line = JSON.stringify(saved) + '\n';
    const result = this.tail
      .then(async () => {
        if (this.failure) throw this.failure;
        const file = this.options.evidenceFile!;
        if (this.bytes === undefined) {
          await mkdir(dirname(file), { recursive: true });
          try {
            this.bytes = (await stat(file)).size;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            this.bytes = 0;
          }
          // Account for segments from a previous reader using the same path.
          for (let i = 1; i < this.maxFiles; i++) {
            try {
              await stat(`${file}.${i}`);
              this.files++;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            }
          }
        }
        const size = Buffer.byteLength(line);
        if (size > this.maxBytes) throw new RpcFailure('evidence-capacity');
        if (this.bytes + size > this.maxBytes) {
          if (this.mode === 'full' && this.files >= this.maxFiles)
            throw new RpcFailure('evidence-capacity');
          for (let i = this.maxFiles - 1; i >= 1; i--) {
            const from = i === 1 ? file : `${file}.${i - 1}`,
              to = `${file}.${i}`;
            try {
              await rm(to, { force: true });
              await rename(from, to);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            }
          }
          if (this.maxFiles === 1) await rm(file, { force: true });
          this.bytes = 0;
          this.files = Math.min(this.files + 1, this.maxFiles);
        }
        await appendFile(file, line);
        this.bytes += size;
      })
      .catch((error) => {
        this.failure = error instanceof RpcFailure ? error : new RpcFailure('evidence-write');
        throw this.failure;
      });
    this.tail = result.catch(() => {});
    // Awaiting every write backpressures RPC producers; concurrent producers are bounded by the reader semaphore.
    await result;
  }
  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}
