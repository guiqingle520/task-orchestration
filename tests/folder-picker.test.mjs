import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFolderPicker, FolderPickerError, runNativeFolderPicker } from '../server/folder-picker.mjs';

test('runNativeFolderPicker returns selected path or cancelled on Windows', async () => {
  const calls = [];
  const selected = await runNativeFolderPicker({
    platform: 'win32',
    runner: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: 'D:\\dev\\payment-service\r\n' };
    },
  });
  assert.deepEqual(selected, { cancelled: false, path: 'D:\\dev\\payment-service' });
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.ok(calls[0].args.includes('-STA'));

  const cancelled = await runNativeFolderPicker({
    platform: 'win32',
    runner: async () => ({ stdout: '' }),
  });
  assert.deepEqual(cancelled, { cancelled: true, path: '' });
});

test('runNativeFolderPicker reports 501 when Linux desktop pickers are missing', async () => {
  await assert.rejects(
    () => runNativeFolderPicker({
      platform: 'linux',
      runner: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    }),
    (err) => err instanceof FolderPickerError && err.status === 501,
  );
});

test('createFolderPicker prevents concurrent dialogs and releases lock after finish', async () => {
  let release;
  const picker = createFolderPicker(() => new Promise((resolve) => { release = resolve; }));
  const first = picker();
  await assert.rejects(
    () => picker(),
    (err) => err instanceof FolderPickerError && err.status === 409,
  );
  release({ cancelled: false, path: 'D:\\dev\\demo' });
  assert.deepEqual(await first, { cancelled: false, path: 'D:\\dev\\demo' });
  const second = picker();
  release({ cancelled: true, path: '' });
  assert.deepEqual(await second, { cancelled: true, path: '' });
});
