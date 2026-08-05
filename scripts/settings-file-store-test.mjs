import assert from 'node:assert/strict';

const { SettingsFileStore } = await import('../dist-electron/settings-file-store.js');

function createFakeOperations(initialContent = 'original\n') {
  const files = new Map([['/settings/settings.json', initialContent]]);
  const cleanupPaths = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let failWrite = false;
  let failRename = false;

  return {
    files,
    cleanupPaths,
    failNextWrite() { failWrite = true; },
    failNextRename() { failRename = true; },
    maxActiveWrites: () => maxActiveWrites,
    operations: {
      async mkdir() {},
      async writeFile(filePath, content) {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await Promise.resolve();
        activeWrites -= 1;
        if (failWrite) {
          failWrite = false;
          throw new Error('temporary-write-failed');
        }
        files.set(filePath, content);
      },
      async rename(sourcePath, targetPath) {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await Promise.resolve();
        activeWrites -= 1;
        if (failRename) {
          failRename = false;
          throw new Error('rename-failed');
        }
        files.set(targetPath, files.get(sourcePath));
        files.delete(sourcePath);
      },
      async unlink(filePath) {
        cleanupPaths.push(filePath);
        files.delete(filePath);
      }
    }
  };
}

const targetPath = '/settings/settings.json';

{
  const fake = createFakeOperations();
  fake.failNextWrite();
  const store = new SettingsFileStore(targetPath, fake.operations);
  await assert.rejects(store.write({ value: 'failed-write' }), /temporary-write-failed/);
  assert.equal(fake.files.get(targetPath), 'original\n');
  assert.equal(fake.cleanupPaths.length, 1);
}

{
  const fake = createFakeOperations();
  fake.failNextRename();
  const store = new SettingsFileStore(targetPath, fake.operations);
  await assert.rejects(store.write({ value: 'failed-rename' }), /rename-failed/);
  assert.equal(fake.files.get(targetPath), 'original\n');
  assert.equal(fake.cleanupPaths.length, 1);
}

{
  const fake = createFakeOperations();
  const store = new SettingsFileStore(targetPath, fake.operations);
  await Promise.all([
    store.write({ value: 'first' }),
    store.write({ value: 'second' }),
    store.write({ value: 'latest' })
  ]);
  assert.equal(fake.maxActiveWrites(), 1);
  assert.equal(fake.files.get(targetPath), '{\n  "value": "latest"\n}\n');
}

{
  const fake = createFakeOperations();
  fake.failNextWrite();
  const store = new SettingsFileStore(targetPath, fake.operations);
  await assert.rejects(store.write({ value: 'failed' }), /temporary-write-failed/);
  await store.write({ value: 'recovered' });
  assert.equal(fake.files.get(targetPath), '{\n  "value": "recovered"\n}\n');
}

{
  const fake = createFakeOperations('{"value":"original"}\n');
  const store = new SettingsFileStore(targetPath, fake.operations);
  const save = store.write({ value: 'saved' });
  let observed;
  const read = store.exclusive(async () => {
    observed = JSON.parse(fake.files.get(targetPath));
  });
  await Promise.all([save, read]);
  assert.deepEqual(observed, { value: 'saved' });
}

{
  const fake = createFakeOperations('{"value":"original"}\n');
  const store = new SettingsFileStore(targetPath, fake.operations);
  const migration = store.exclusive(async writeAtomically => {
    const observed = JSON.parse(fake.files.get(targetPath));
    await writeAtomically({ value: `migrated-from-${observed.value}` });
  });
  const save = store.write({ value: 'saved' });
  await Promise.all([migration, save]);
  assert.equal(fake.files.get(targetPath), '{\n  "value": "saved"\n}\n');
}

console.log('settings file store tests passed');
