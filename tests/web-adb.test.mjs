import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AdbSession } from '../site/adb.mjs';
import { adbShellFrame, createToolboxUsbMock } from './fixtures/toolbox-usb.mjs';

function mock(t) {
  if (!globalThis.USBConnectionEvent) {
    globalThis.USBConnectionEvent = class extends Event {
      constructor(type, { device }) { super(type); this.device = device; }
    };
    t.after(() => { delete globalThis.USBConnectionEvent; });
  }
  return createToolboxUsbMock();
}

async function connect(t, fixture) {
  const session = await AdbSession.connect(fixture.usb);
  t.after(() => session.close());
  return session;
}

const REBOOTS = [['system', 'reboot:'], ['bootloader', 'reboot:bootloader'], ['fastbootd', 'reboot:fastboot'],
  ['recovery', 'reboot:recovery'], ['edl', 'reboot:edl']];

test('opens the standard ADB chooser and leaves a cancelled device unopened', async t => {
  const f = mock(t);
  f.state.cancel = true;
  await assert.rejects(AdbSession.connect(f.usb), { name: 'NotFoundError' });
  assert.deepEqual(f.state.filters, [{ classCode: 255, subclassCode: 66, protocolCode: 1 }]);
  assert.equal(f.adb.device.opened, false);
});

test('classifies a failed ADB interface claim before authorization and allows retry', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.adbClaimError = 'NetworkError';
  await assert.rejects(AdbSession.connect(f.usb), error => {
    assert.equal(error.code, 'adbInterfaceUnavailable');
    assert.equal(error.cause?.cause?.name, 'NetworkError');
    return true;
  });
  assert.equal(f.adb.device.opened, false);
  assert.deepEqual(f.state.adbPackets, []);
  f.state.adbClaimError = null;
  const session = await connect(t, f);
  assert.equal(session.ready, true);
});

test('connects an authorized device and falls back to the running slot property', { timeout: 5_000 }, async t => {
  const f = mock(t);
  const session = await connect(t, f);
  assert.equal(session.device, f.adb.device);
  assert.equal(session.ready, true);
  assert.equal(f.state.adbPackets[0].command, 'CNXN');
  assert.equal(await session.readBootSlot(), 'b');
  assert.deepEqual(f.state.adbServices, ['exec:getprop ro.boot.slot_suffix', 'exec:getprop ro.boot.slot']);
});

test('keeps an available slot suffix and serializes reboot services', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.bootSlotSuffix = '_a';
  const session = await connect(t, f);
  assert.equal(await session.readBootSlot(), '_a');
  await assert.rejects(session.reboot('constructor'), { code: 'adbInvalidTarget' });
  for (const [target] of REBOOTS) assert.equal(await session.reboot(target), undefined);
  assert.deepEqual(f.state.adbServices, ['exec:getprop ro.boot.slot_suffix', ...REBOOTS.map(([, service]) => service)]);
});

test('reports reboot service refusal before OPEN and errors received after OPEN', { timeout: 5_000 }, async t => {
  const f = mock(t);
  const session = await connect(t, f);
  f.state.rejectReboot = true;
  await assert.rejects(session.reboot('edl'), { code: 'adbRebootRejected' });
  f.state.rejectReboot = false;
  f.state.rebootError = 'Mode not supported';
  await assert.rejects(session.reboot('recovery'), { code: 'adbRebootRejected', message: 'Mode not supported' });
  assert.equal(session.ready, true);
});

test('close remains idempotent when a disconnect listener closes the same session', { timeout: 5_000 }, async t => {
  const session = await connect(t, mock(t));
  let nestedClose;
  session.disconnectSignal.addEventListener('abort', () => { nestedClose = session.close(); });
  const close = session.close();
  assert.equal(nestedClose, close);
  await close;
  assert.equal(session.ready, false);
});

test('disconnect before the reboot acknowledgement is unconfirmed', { timeout: 5_000 }, async t => {
  const f = mock(t);
  const session = await connect(t, f);
  f.state.holdReboot = true;
  const pending = assert.rejects(session.reboot('bootloader'), { code: 'adbRebootUnconfirmed' });
  await waitFor(() => f.state.adbServices.includes('reboot:bootloader'), 'Expected a pending reboot OPEN');
  assert.equal(session.disconnectSignal.aborted, false);
  f.adb.disconnect();
  await pending;
  assert.equal(session.disconnectSignal.aborted, true);
  assert.equal(session.ready, false);
});

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await delay(1);
  assert.ok(predicate(), message);
}

const shellOpened = fixture => fixture.state.adbPackets.find(packet => packet.command === 'OPEN');
const shellClosed = fixture => fixture.state.adbPackets.some(packet =>
  packet.command === 'CLSE' && packet.arg0 === shellOpened(fixture)?.arg0);
const join = (...chunks) => Uint8Array.from(chunks.flatMap(chunk => [...chunk]));

function controlDeadline(t, milliseconds) {
  const setTimer = globalThis.setTimeout;
  let expire;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === milliseconds && !expire) expire = () => callback(...args);
    return setTimer(callback, ms, ...args);
  });
  return () => {
    assert.ok(expire, 'Expected the adapter to start its deadline timer');
    expire();
  };
}

test('streams raw shell v2 frames with independent UTF-8 decoders and a numeric exit', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.adbFeatures = ['shell_v2'];
  f.state.holdShell = true;
  const outStart = adbShellFrame(1, Uint8Array.of(0x41, 0xe4));
  const errStart = adbShellFrame(2, Uint8Array.of(0x42, 0xf0, 0x9f));
  const outEnd = adbShellFrame(1, Uint8Array.of(0xb8, 0xad, 0x21));
  f.state.adbShellChunks = [outStart.subarray(0, 2), outStart.subarray(2, 6),
    join(outStart.subarray(6), errStart, outEnd)];
  const session = await connect(t, f);
  const seen = [];
  const command = '  printf "  line  "\nprintf done  ';
  const pending = session.runShell(command, { onOutput: (text, kind) => seen.push([kind, text]) });
  void pending.catch(() => {}); // The fixture closes the socket if a streaming assertion fails first.
  await waitFor(() => seen.length === 3, 'Expected output before the shell exited');
  assert.deepEqual(seen, [['stdout', 'A'], ['stderr', 'B'], ['stdout', '\u4e2d!']]);
  f.sendShellChunk(join(adbShellFrame(2, Uint8Array.of(0x99, 0x82, 0x3f, 0xe2)), adbShellFrame(99, 'ignored')));
  f.sendShellChunk(adbShellFrame(3, Uint8Array.of(23)).subarray(0, 5));
  f.sendShellChunk(Uint8Array.of(23));
  assert.deepEqual(await pending, { exitCode: 23 });
  assert.deepEqual(seen.slice(3), [['stderr', '\u{1f642}?'], ['stderr', '\ufffd']]);
  assert.deepEqual(f.state.adbServices, ['shell,v2,raw:' + command]);
  assert.deepEqual(f.state.adbShellStdin, [Uint8Array.of(4, 0, 0, 0, 0)]);
  assert.ok(shellClosed(f));
  assert.equal(session.ready, true);
});

test('uses raw legacy exec for devices without shell v2 and returns no exit code', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.adbFeatures = ['cmd'];
  f.state.adbProtocolVersion = 0x01000000;
  f.state.adbShellChunks = [Uint8Array.of(0xe4, 0xb8), Uint8Array.of(0xad, 0x0a)];
  const session = await connect(t, f);
  const seen = [];
  assert.deepEqual(await session.runShell('echo legacy', { onOutput: (text, kind) => seen.push([kind, text]) }), { exitCode: null });
  assert.deepEqual(seen, [['stdout', '\u4e2d\n']]);
  assert.deepEqual(f.state.adbServices, ['exec:echo legacy']);
  assert.equal(shellOpened(f).length, 'exec:echo legacy'.length + 1);
  assert.deepEqual(f.state.adbShellStdin, []);
});

test('validates shell commands in bytes and never opens for a pre-aborted signal', { timeout: 5_000 }, async t => {
  const f = mock(t);
  const session = await connect(t, f);
  for (const command of [null, '', ' \n\t', 'echo a\0b', 'a'.repeat(4_001), '\u00e9'.repeat(2_001)]) {
    await assert.rejects(session.runShell(command), { code: 'adbInvalidCommand' });
  }
  const stopped = new DOMException('Stopped before run', 'AbortError');
  await assert.rejects(session.runShell('echo valid', { signal: AbortSignal.abort(stopped) }), error => error === stopped);
  assert.deepEqual(f.state.adbServices, []);
  assert.deepEqual(await session.runShell('a'.repeat(4_000)), { exitCode: null });
  assert.equal(f.state.adbServices.length, 1);
});

test('reads Android model, release, and SDK from fixed getprop keys', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.deviceInfo = { model: ' Mock phone ', release: '', sdk: '34' };
  const session = await connect(t, f);
  assert.deepEqual(await session.readDeviceInfo(), { model: 'Mock phone', release: null, sdk: '34' });
  assert.deepEqual(f.state.adbServices, ['exec:getprop ro.product.model', 'exec:getprop ro.build.version.release',
    'exec:getprop ro.build.version.sdk']);
});

test('Stop closes the shell socket and keeps status and reboot busy during cleanup', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.adbFeatures = ['shell_v2'];
  f.state.holdShell = true;
  f.state.holdShellClose = true;
  const session = await connect(t, f);
  const controller = new AbortController();
  const seen = [];
  const pending = assert.rejects(session.runShell('echo running', {
    signal: controller.signal,
    onOutput: text => seen.push(text),
  }), { name: 'AbortError' });
  await waitFor(() => seen.length, 'Expected initial shell output');
  await assert.rejects(session.runShell('echo busy'), { code: 'adbBusy' });
  await assert.rejects(session.readDeviceInfo(), { code: 'adbBusy' });
  controller.abort();
  await waitFor(() => shellClosed(f), 'Stop must send CLSE');
  await assert.rejects(session.readBootSlot(), { code: 'adbBusy' });
  await assert.rejects(session.reboot('recovery'), { code: 'adbBusy' });
  f.acknowledgeShellClose();
  await pending;
  assert.deepEqual(seen, ['Mock shell\n']);
  assert.equal(session.ready, true);
  assert.equal(await session.readBootSlot(), 'b');
});

test('Stop before OPEN acknowledgement returns and closes an eventual late socket', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.adbFeatures = ['shell_v2'];
  f.state.holdShellOpen = true;
  f.state.holdShell = true;
  const session = await connect(t, f);
  const controller = new AbortController();
  const seen = [];
  const stopped = new Error('Shell stop requested');
  const pending = assert.rejects(session.runShell('echo late', {
    signal: controller.signal, onOutput: text => seen.push(text),
  }), error => error === stopped);
  await waitFor(() => shellOpened(f), 'Expected a pending ADB OPEN');
  controller.abort(stopped);
  await pending;
  assert.equal(shellClosed(f), false);
  f.acceptShell();
  await waitFor(() => shellClosed(f), 'Expected CLSE for the late socket');
  assert.deepEqual(seen, []);
  assert.deepEqual(f.state.adbShellStdin, []);
  assert.deepEqual(f.state.adbServices, ['shell,v2,raw:echo late']);
  assert.equal(await session.readBootSlot(), 'b');
});

test('times out an unacknowledged shell OPEN and closes the late socket without retry', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.holdShellOpen = true;
  f.state.holdShell = true;
  const session = await connect(t, f);
  const expire = controlDeadline(t, 15_000);
  const pending = assert.rejects(session.runShell('echo timeout'), { code: 'timeout' });
  await waitFor(() => shellOpened(f), 'Expected a pending ADB OPEN');
  expire();
  await pending;
  f.acceptShell();
  await waitFor(() => shellClosed(f), 'Expected CLSE for the timed-out socket');
  assert.deepEqual(f.state.adbServices, ['exec:echo timeout']);
});

test('invalidates the session if the daemon does not acknowledge a stopped shell close', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.holdShell = true;
  f.state.holdShellClose = true;
  const session = await connect(t, f);
  const expire = controlDeadline(t, 3_000);
  const controller = new AbortController();
  const seen = [];
  const pending = assert.rejects(session.runShell('echo stuck', {
    signal: controller.signal, onOutput: text => seen.push(text),
  }), { name: 'AbortError' });
  await waitFor(() => seen.length, 'Expected legacy shell output');
  controller.abort();
  await waitFor(() => shellClosed(f), 'Expected a pending shell CLSE');
  expire();
  await pending;
  assert.equal(session.ready, false);
  await session.close();
  assert.equal(f.adb.device.opened, false);
});

test('disconnect rejects a running shell and does not return an exit result', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.adbFeatures = ['shell_v2'];
  f.state.holdShell = true;
  const session = await connect(t, f);
  const seen = [];
  const pending = assert.rejects(session.runShell('echo online', { onOutput: text => seen.push(text) }),
    { code: 'disconnected' });
  await waitFor(() => seen.length, 'Expected shell output before disconnect');
  f.adb.disconnect();
  await pending;
  assert.deepEqual(seen, ['Mock shell\n']);
  assert.equal(session.ready, false);
  assert.equal(session.disconnectSignal.aborted, true);
});

test('does not run a command again after a v2 OPEN refusal or missing exit packet', { timeout: 5_000 }, async t => {
  const f = mock(t);
  f.state.adbFeatures = ['shell_v2'];
  f.state.rejectShellOpen = true;
  const session = await connect(t, f);
  await assert.rejects(session.runShell('echo refused'), { message: 'Socket open failed' });
  assert.deepEqual(f.state.adbServices, ['shell,v2,raw:echo refused']);
  f.state.rejectShellOpen = false;
  f.state.adbShellChunks = [adbShellFrame(1, 'No exit')];
  await assert.rejects(session.runShell('echo no-exit'), { code: 'adbShellProtocol' });
  f.state.adbShellChunks = [adbShellFrame(3, new Uint8Array())];
  await assert.rejects(session.runShell('echo invalid-exit'), { code: 'adbShellProtocol' });
  assert.equal(session.ready, true);
  assert.deepEqual(f.state.adbServices, ['shell,v2,raw:echo refused', 'shell,v2,raw:echo no-exit', 'shell,v2,raw:echo invalid-exit']);
});
