import fs from 'fs/promises';
import path from 'path';

function clone(value) {
  return structuredClone(value);
}

export function createLegacyJsonStore({ filePath, readOnly = false }) {
  if (!filePath) throw new Error('A legacy JSON file path is required.');
  let queue = Promise.resolve();

  async function read() {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  }

  async function write(value) {
    if (readOnly) throw new Error('The legacy JSON backup is read-only.');
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  }

  async function transaction(work) {
    const pending = queue.then(async () => {
      const draft = clone(await read());
      const result = await work(draft);
      await write(draft);
      return result;
    });
    queue = pending.catch(() => undefined);
    return pending;
  }

  async function health() {
    try {
      await fs.access(filePath);
      return { status: 'ok', driver: 'json', readOnly };
    } catch {
      return { status: 'unavailable', driver: 'json', readOnly };
    }
  }

  return Object.freeze({ filePath, readOnly, read, write, transaction, health });
}
