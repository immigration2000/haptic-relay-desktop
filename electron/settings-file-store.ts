import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SettingsFileOperations {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export class SettingsFileStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly settingsPath: string,
    private readonly operations: SettingsFileOperations = fs
  ) {}

  write(settings: unknown): Promise<void> {
    return this.exclusive(writeAtomically => writeAtomically(settings));
  }

  exclusive<T>(operation: (writeAtomically: (settings: unknown) => Promise<void>) => Promise<T>): Promise<T> {
    const result = this.queue.then(() => operation(settings => this.writeAtomically(settings)));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async writeAtomically(settings: unknown) {
    const directory = path.dirname(this.settingsPath);
    const temporaryPath = path.join(directory, `.${path.basename(this.settingsPath)}.${randomUUID()}.tmp`);
    const content = `${JSON.stringify(settings, null, 2)}\n`;

    await this.operations.mkdir(directory, { recursive: true });
    try {
      await this.operations.writeFile(temporaryPath, content, 'utf8');
      await this.operations.rename(temporaryPath, this.settingsPath);
    } catch (error) {
      try {
        await this.operations.unlink(temporaryPath);
      } catch {
        // Temporary-file cleanup is best effort.
      }
      throw error;
    }
  }
}
