import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class FolderPickerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function windowsOneShotScript(initialPath) {
  const b64 = Buffer.from(initialPath || '', 'utf8').toString('base64');
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择包含 plan/plan.md 的本地仓库文件夹'",
    '$dialog.UseDescriptionForTitle = $true',
    '$dialog.ShowNewFolderButton = $false',
    `$init = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`,
    'if ($init -and (Test-Path -LiteralPath $init)) { $dialog.SelectedPath = $init }',
    'try {',
    '  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '    [Console]::Out.Write($dialog.SelectedPath)',
    '  }',
    '} finally {',
    '  $dialog.Dispose()',
    '  $owner.Dispose()',
    '}',
  ].join('; ');
}

const WINDOWS_WORKER_SCRIPT = [
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$dialog.Description = '选择包含 plan/plan.md 的本地仓库文件夹'",
  '$dialog.UseDescriptionForTitle = $true',
  '$dialog.ShowNewFolderButton = $false',
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  'while (($line = [Console]::In.ReadLine()) -ne $null) {',
  "  if ($line -eq 'QUIT') { break }",
  '  $init = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line))',
  '  if ($init -and (Test-Path -LiteralPath $init)) { $dialog.SelectedPath = $init }',
  "  $res = ''",
  '  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $res = $dialog.SelectedPath }',
  '  $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($res))',
  "  [Console]::Out.WriteLine('RESULT:' + $b64)",
  '  [Console]::Out.Flush()',
  '}',
  '$dialog.Dispose()',
  '$owner.Dispose()',
].join('; ');

function createWindowsWorker(idleMs = 180000) {
  let child = null;
  let readyPromise = null;
  let pending = null;
  let idleTimer = null;
  let buffer = '';

  function dispose() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const current = child;
    child = null;
    readyPromise = null;
    buffer = '';
    if (pending) {
      const reject = pending.reject;
      pending = null;
      reject(new FolderPickerError(500, '文件夹选择器意外退出，请重试'));
    }
    if (current && current.exitCode === null) {
      try { current.stdin.write('QUIT\n'); } catch { /* ignore */ }
      try { current.kill(); } catch { /* ignore */ }
    }
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(dispose, idleMs);
    idleTimer.unref?.();
  }

  process.once('exit', dispose);

  function ensureStarted() {
    if (child && child.exitCode === null && readyPromise) {
      scheduleIdle();
      return readyPromise;
    }
    dispose();
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_WORKER_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    proc.unref?.();
    child = proc;
    scheduleIdle();

    readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const failStart = (err) => {
        if (!settled) { settled = true; reject(err); }
      };
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line === 'READY' && !settled) {
            settled = true;
            resolve();
          } else if (line.startsWith('RESULT:') && pending) {
            const { resolve: done } = pending;
            pending = null;
            scheduleIdle();
            const selected = Buffer.from(line.slice(7), 'base64').toString('utf8').trim();
            done(selected ? { cancelled: false, path: selected } : { cancelled: true, path: '' });
          }
        }
      });
      proc.on('error', () => {
        failStart(new FolderPickerError(500, '无法启动系统文件夹选择器'));
        dispose();
      });
      proc.on('exit', () => {
        failStart(new FolderPickerError(500, '系统文件夹选择器提前退出'));
        if (child === proc) dispose();
      });
    });
    return readyPromise;
  }

  async function pick(initialPath = '') {
    const safeInit = typeof initialPath === 'string' && initialPath.trim() && existsSync(initialPath.trim()) ? initialPath.trim() : '';
    await ensureStarted();
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      const encoded = Buffer.from(safeInit, 'utf8').toString('base64');
      try {
        child.stdin.write(encoded + '\n');
      } catch {
        pending = null;
        dispose();
        reject(new FolderPickerError(500, '无法唤起系统文件夹选择器，请重试'));
      }
    });
  }

  function warmup() {
    void ensureStarted().catch(() => { /* 静默忽略预热失败，正式点击时会报错或回退 */ });
  }

  return { pick, warmup, dispose };
}

export async function runNativeFolderPicker({ platform = process.platform, initialPath = '', runner = execFileAsync } = {}) {
  const safeInit = typeof initialPath === 'string' && initialPath.trim() && existsSync(initialPath.trim()) ? initialPath.trim() : '';
  if (platform === 'win32') {
    const { stdout } = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', windowsOneShotScript(safeInit)], {
      windowsHide: true,
      timeout: 300000,
      maxBuffer: 64 * 1024,
    });
    const selected = String(stdout || '').trim();
    return selected ? { cancelled: false, path: selected } : { cancelled: true, path: '' };
  }
  if (platform === 'darwin') {
    try {
      const { stdout } = await runner('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择包含 plan/plan.md 的本地仓库文件夹")'], { timeout: 300000 });
      const selected = String(stdout || '').trim().replace(/\/+$/, '') || '/';
      return { cancelled: false, path: selected };
    } catch (err) {
      if (String(err?.stderr || err?.message || '').includes('-128')) return { cancelled: true, path: '' };
      throw new FolderPickerError(500, '无法打开系统文件夹选择器，请手动输入路径');
    }
  }
  for (const [cmd, args] of [
    ['zenity', ['--file-selection', '--directory', '--title=选择本地仓库文件夹']],
    ['kdialog', ['--getexistingdirectory', safeInit || '.']],
  ]) {
    try {
      const { stdout } = await runner(cmd, args, { timeout: 300000 });
      const selected = String(stdout || '').trim();
      return selected ? { cancelled: false, path: selected } : { cancelled: true, path: '' };
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      if (err?.code === 1) return { cancelled: true, path: '' };
      throw new FolderPickerError(500, '无法打开系统文件夹选择器，请手动输入路径');
    }
  }
  throw new FolderPickerError(501, '当前环境不支持系统文件夹选择器，请手动输入绝对路径');
}

export function createFolderPicker(pick = null) {
  const winWorker = !pick && process.platform === 'win32' ? createWindowsWorker() : null;
  let busy = false;
  async function openPicker(options = {}) {
    if (busy) throw new FolderPickerError(409, '文件夹选择窗口已打开，请先完成选择');
    busy = true;
    try {
      if (pick) return await pick(options);
      if (winWorker) return await winWorker.pick(options.initialPath);
      return await runNativeFolderPicker(options);
    } catch (err) {
      if (err instanceof FolderPickerError) throw err;
      throw new FolderPickerError(500, '无法打开系统文件夹选择器，请手动输入路径');
    } finally {
      busy = false;
    }
  }
  openPicker.warmup = () => { if (winWorker) winWorker.warmup(); };
  openPicker.dispose = () => { if (winWorker) winWorker.dispose(); };
  return openPicker;
}
