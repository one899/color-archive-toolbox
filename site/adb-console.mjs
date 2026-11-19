import { isFastbootVariableName } from './fastboot.mjs';

const OUTPUT_LIMIT = 128 * 1024;
const MAX_RUNS = 320;
const COMMAND_LIMIT = 4000;
const PRESETS = new Map([
  ['identity', 'id'],
  ['system', 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk'],
  ['storage', 'df -h /data /sdcard'],
  ['recentLogs', 'logcat -d -t 200'],
  ['liveLogs', 'logcat -T 1'],
]);

const plainText = value => String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');

export function createTranscript(limit = OUTPUT_LIMIT) {
  const chunks = [];
  let chars = 0;
  let truncated = false;
  return {
    get chunks() { return chunks; },
    get length() { return chars; },
    get truncated() { return truncated; },
    get text() { return chunks.map(chunk => chunk.text).join(''); },
    append(value, kind = 'stdout') {
      const text = plainText(value);
      if (!text) return;
      const tail = chunks.at(-1);
      if (tail?.kind === kind) tail.text += text;
      else chunks.push({ text, kind });
      chars += text.length;
      while (chunks.length > MAX_RUNS || chars > limit) {
        const first = chunks[0];
        const excess = chars - limit;
        truncated = true;
        if (chunks.length > MAX_RUNS || first.text.length <= excess) {
          chars -= chunks.shift().text.length;
        } else {
          const next = first.text.charCodeAt(excess);
          const drop = next >= 0xdc00 && next <= 0xdfff ? excess + 1 : excess;
          first.text = first.text.slice(drop);
          chars -= drop;
          if (!first.text) chunks.shift();
        }
      }
    },
    clear() { chunks.length = 0; chars = 0; truncated = false; },
  };
}

const REBOOT_TARGETS = new Map([
  ['reboot', 'system'], ['reboot system', 'system'],
  ['reboot-bootloader', 'bootloader'], ['reboot bootloader', 'bootloader'],
  ['reboot-fastboot', 'fastbootd'], ['reboot fastboot', 'fastbootd'], ['reboot fastbootd', 'fastbootd'],
  ['reboot-recovery', 'recovery'], ['reboot recovery', 'recovery'],
  ['reboot-edl', 'edl'], ['reboot edl', 'edl'],
]);

export function parseFastbootCommand(raw) {
  if (typeof raw !== 'string' || /[^\x20-\x7e\t]/.test(raw)) return null;
  const command = raw.trim().replace(/[ \t]+/g, ' ').replace(/^fastboot /, '');
  const name = /^(?:getvar |getvar:)(.+)$/.exec(command)?.[1];
  if (name && isFastbootVariableName(name)) return { kind: 'query', name, display: 'getvar ' + name };
  const target = REBOOT_TARGETS.get(command);
  if (target) return { kind: 'reboot', target, display: command };
  const slot = /^set_active[ :]([ab])$/.exec(command)?.[1];
  return slot ? { kind: 'slot', target: slot, display: 'set_active ' + slot } : null;
}

function protocolName(link) {
  if (!link) return 'USB';
  if (link.kind === 'adb') return 'Android Shell (ADB)';
  if (link.state.mode === 'fastbootd') return 'fastbootd (FBD)';
  if (link.state.mode === 'bootloader') return 'Fastboot (FB)';
  return 'Fastboot';
}

export function createDeviceConsole({ ui, t, getLink, canRun, showTerminal, onBusyChange, formatError, reviewControl }) {
  const transcript = createTranscript();
  const groups = document.querySelectorAll('[data-command-mode]');
  const presets = document.querySelectorAll('[data-adb-preset], [data-fastboot-preset]');
  let job = null;
  let notice = null;
  let drawTimer = null;
  let observedLink = null;

  function render() {
    const link = getLink();
    if (link && link !== observedLink) {
      notice = null;
      ui.adbCommand.value = '';
    }
    observedLink = link;
    const kind = link?.kind;
    const adb = kind === 'adb';
    const enabled = !!link && !job && canRun();
    ui.adbRun.disabled = ui.adbCommand.disabled = !enabled;
    ui.adbStop.disabled = !job || job.stopping;
    ui.adbStop.title = job?.kind === 'fastboot'
      ? t('停止查询会断开 Fastboot，需要重新连接。', 'Stopping a query disconnects Fastboot. Reconnect to continue.') : '';
    ui.adbClear.disabled = ui.adbCopy.disabled = !transcript.length;
    for (const group of groups) group.hidden = group.dataset.commandMode !== kind;
    for (const button of presets) button.disabled = !enabled || (adb ? !button.dataset.adbPreset : !button.dataset.fastbootPreset);
    ui.consoleMode.textContent = protocolName(link);
    ui.consolePrompt.textContent = adb ? '$' : '›';
    ui.adbCommand.placeholder = adb ? t('例如 getprop ro.product.model', 'e.g. getprop ro.product.model')
      : link ? t('例如 fastboot getvar product', 'e.g. fastboot getvar product')
        : t('连接设备后输入指令', 'Connect a device to enter commands');
    ui.adbQuickHint.textContent = adb
      ? t('在终端查看系统信息和 logcat。', 'See Android system information and logcat in the terminal.')
      : link ? t('直接查询设备代号、槽位和其他变量。', 'Query the product, active slot, and other variables.')
        : t('通过 USB 连接设备后显示对应指令。', 'Connect a device over USB to see the available commands.');
    ui.adbHelp.textContent = adb
      ? t('输入 Android Shell 指令。输出保留在当前浏览器。', 'Enter an Android shell command. Output stays in this browser.')
      : link ? t('支持 getvar 查询、重启和切槽。此源码版不包含镜像写入。', 'Use getvar, reboot, or set_active. Image writing is not included in this source edition.')
        : t('ADB 支持 Android Shell。FB 和 FBD 支持 Fastboot 指令。', 'Use Android shell in ADB or Fastboot commands in FB and FBD.');
    const state = notice ?? { text: link ? enabled
      ? adb ? t('ADB 已连接，可以执行命令。', 'ADB connected. Ready for a command.')
        : t('Fastboot 已连接，可以执行指令。', 'Fastboot connected. Ready for a command.')
      : t('设备正在用于其他操作。', 'The device is in use by another operation.')
      : t('请先通过 USB 连接设备。', 'Connect a device over USB.') };
    if (ui.adbConsoleStatus.textContent !== state.text) ui.adbConsoleStatus.textContent = state.text;
    ui.adbConsoleStatus.dataset.kind = state.kind ?? '';
  }

  function draw() {
    drawTimer = null;
    const screen = ui.adbScreen;
    const follow = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 36;
    const content = document.createDocumentFragment();
    if (transcript.truncated) {
      const label = document.createElement('span');
      label.className = 'terminal-meta-output';
      label.textContent = t('[较早的输出已省略]\n', '[Earlier output omitted]\n');
      content.append(label);
    }
    for (const part of transcript.chunks) {
      const span = document.createElement('span');
      span.dataset.stream = part.kind;
      span.textContent = part.text;
      content.append(span);
    }
    ui.adbOutput.replaceChildren(content);
    if (follow) screen.scrollTop = screen.scrollHeight;
    ui.adbClear.disabled = ui.adbCopy.disabled = !transcript.length;
  }

  function append(text, kind) {
    transcript.append(text, kind);
    if (drawTimer === null) drawTimer = setTimeout(draw, 50);
  }

  function line(text, kind) {
    const prior = transcript.chunks.at(-1)?.text;
    append((prior && !prior.endsWith('\n') ? '\n' : '') + text + '\n', kind);
  }

  function say(text, kind = '') { notice = { text, kind }; render(); }

  function runAdb(raw) {
    const command = raw.trim().replace(/^adb[ \t]+shell(?:[ \t]+|$)/, '').trim();
    if (!command || command.includes('\0') || new TextEncoder().encode(command).length > COMMAND_LIMIT || /^(?:adb|fastboot)(?:\s|$)/.test(command)) {
      say(t('请输入 Android Shell 命令，例如 getprop ro.product.model。', 'Enter an Android shell command, such as getprop ro.product.model.'), 'error');
      return null;
    }
    return command;
  }

  async function run(raw) {
    const link = getLink();
    if (!link || job || !canRun()) return;
    const adb = link.kind === 'adb';
    const command = adb ? runAdb(raw) : parseFastbootCommand(raw);
    if (!command) {
      if (!adb) say(t('支持 getvar、reboot 和 set_active。刷入镜像请用刷写队列。', 'Use getvar, reboot, or set_active. Use the image queue for flashing.'), 'error');
      return;
    }
    if (!adb && command.kind !== 'query') {
      if (!reviewControl(command)) say(t('当前设备无法执行该操作。请检查模式和槽位。', 'This action is unavailable for the current device. Check its mode and slot.'), 'error');
      return;
    }
    const current = { kind: link.kind, controller: new AbortController(), stopping: false };
    job = current;
    line(adb ? '$ ' + command : '> fastboot ' + command.display, 'command');
    notice = { text: t('执行中…', 'Running…') };
    onBusyChange(true);
    try {
      const signal = current.controller.signal;
      if (adb) {
        const {exitCode} = await link.session.runShell(command, {
          signal, onOutput(text, kind) { if (!current.stopping) append(text, kind); },
        });
        signal.throwIfAborted();
        const completed = exitCode === null
          ? t('命令输出结束（设备未返回退出码）。', 'Command output ended (no exit code reported).')
          : t('命令退出码：', 'Command exit code: ') + exitCode;
        line('[' + completed + ']', 'system');
        say(completed, exitCode === 0 ? 'success' : exitCode === null ? '' : 'error');
      } else {
        const value = await link.session.getVariable(command.name, {
          signal,
          onInfo(text, tag) {
            if (current.stopping) return;
            if (tag === 'TEXT') append(text, 'stdout');
            else line('INFO ' + text.trimEnd(), 'info');
          },
        });
        signal.throwIfAborted();
        line(value ? 'OKAY ' + value : 'OKAY', 'success');
        say(t('设备已返回查询结果。', 'The device returned the query result.'), 'success');
      }
    } catch (error) {
      const message = current.stopping
        ? adb ? t('已停止接收输出。设备上的后台进程可能仍在运行。', 'Stopped receiving output. A background process on the device may still be running.')
          : t('已停止查询。请重新连接 Fastboot 设备。', 'Query stopped. Reconnect the Fastboot device.')
        : error?.code === 'adbInvalidCommand' ? t('命令超过当前设备允许的长度。', 'The command exceeds the limit for this device.')
          : error?.code === 'adbShellProtocol' ? t('ADB 命令输出不完整。', 'ADB command output was incomplete.')
            : formatError(error);
      const refused = !adb && error?.code === 'deviceRejected';
      line(refused ? 'FAIL ' + (error.detail || message) : '[' + message + ']', current.stopping ? 'system' : 'stderr');
      say(message, current.stopping ? '' : 'error');
    } finally {
      job = null;
      onBusyChange(false);
    }
  }

  ui.adbForm.addEventListener('submit', event => {
    event.preventDefault();
    void run(ui.adbCommand.value);
  });
  ui.adbStop.addEventListener('click', () => {
    if (!job || job.stopping) return;
    job.stopping = true;
    job.controller.abort();
    say(t('正在停止接收输出…', 'Stopping output…'));
  });
  ui.adbClear.addEventListener('click', () => {
    transcript.clear();
    if (drawTimer !== null) clearTimeout(drawTimer);
    draw();
  });
  ui.adbCopy.addEventListener('click', async () => {
    if (!transcript.length) return;
    try {
      const label = transcript.truncated ? t('[较早的输出已省略]\n', '[Earlier output omitted]\n') : '';
      await navigator.clipboard.writeText(label + transcript.text);
      if (!job) say(t('已复制输出。', 'Output copied.'), 'success');
    } catch {
      if (!job) say(t('复制未成功，可以选中输出后手动复制。', 'Could not copy automatically. Select the output and copy it manually.'), 'error');
    }
  });
  for (const button of presets) button.addEventListener('click', () => {
    const link = getLink();
    if (!link || job || !canRun()) return;
    const name = button.dataset.fastbootPreset;
    const command = link.kind === 'adb' ? PRESETS.get(button.dataset.adbPreset) : name && 'getvar ' + name;
    if (!command) return;
    showTerminal();
    ui.adbCommand.value = command;
    void run(command);
  });
  return {
    render,
    startControl(command) { line('> fastboot ' + command, 'command'); },
    controlInfo(text) { line(text, 'info'); },
    controlResult(message, kind) {
      line('[' + message + ']', kind === 'error' ? 'stderr' : 'success');
      say(message, kind);
    },
  };
}
