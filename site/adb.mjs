import {
  Adb, AdbDaemonTransport, AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager, AdbWebCredentialStore,
} from './vendor/web-adb.mjs';

const USB_TIMEOUT = 15_000;
const AUTH_TIMEOUT = 120_000;
const CLOSE_TIMEOUT = 3_000;
const STATUS_TIMEOUT = 5_000;
const REBOOT_TIMEOUT = 15_000;
const SHELL_OPEN_TIMEOUT = 15_000;
const MAX_SHELL_COMMAND_BYTES = 4_000;
const SHELL_STDOUT = 1;
const SHELL_STDERR = 2;
const SHELL_EXIT = 3;
const SHELL_CLOSE_STDIN = Uint8Array.of(4, 0, 0, 0, 0);

const REBOOT_SERVICES = new Map([
  ['system', 'reboot:'],
  ['bootloader', 'reboot:bootloader'],
  ['fastbootd', 'reboot:fastboot'],
  ['recovery', 'reboot:recovery'],
  ['edl', 'reboot:edl'],
]);

class AdbError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'AdbError';
    this.code = code;
  }
}

const disconnected = () => new AdbError('disconnected', 'The ADB device disconnected.');
const noOp = () => {};

async function timed(run, ms, error, signal) {
  signal?.throwIfAborted();
  let timer;
  const abort = () => rejectStop(signal.reason);
  let rejectStop;
  const stop = new Promise((_, reject) => {
    rejectStop = reject;
    timer = setTimeout(() => reject(error), ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(run), stop]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const closeWithinDeadline = run => timed(run, CLOSE_TIMEOUT, new AdbError('timeout', 'Closing the ADB connection timed out.'));

async function closeWebUsb(device, connection) {
  // Failed authentication deliberately leaves the connection open upstream.
  // Prefer the transport stream's close hook, which also removes its USB listener.
  if (connection && !connection.writable.locked) {
    await closeWithinDeadline(() => connection.writable.close()).catch(noOp);
  }
  if (device.opened) await closeWithinDeadline(() => device.close());
}

async function readShellV2(read, emit) {
  // A shell frame can span several ADB packets. Decode output as it arrives
  // without allocating a buffer of the length supplied in the frame header.
  const header = new Uint8Array(5);
  const headerView = new DataView(header.buffer);
  let headerBytes = 0;
  let remaining = 0;
  let id;
  while (true) {
    const { done, value } = await read();
    if (done) {
      const message = remaining || headerBytes ? 'The ADB shell ended inside a packet.' :
        'The ADB shell ended without an exit code.';
      throw new AdbError('adbShellProtocol', message);
    }
    for (let offset = 0; offset < value.length;) {
      if (!remaining) {
        const size = Math.min(header.length - headerBytes, value.length - offset);
        header.set(value.subarray(offset, offset + size), headerBytes);
        headerBytes += size;
        offset += size;
        if (headerBytes < header.length) break;
        headerBytes = 0;
        id = header[0];
        remaining = headerView.getUint32(1, true);
        if (id === SHELL_EXIT && remaining !== 1) {
          throw new AdbError('adbShellProtocol', 'The ADB shell returned an invalid exit packet.');
        }
        if (!remaining) continue;
      }
      if (offset === value.length) break;
      if (id === SHELL_EXIT) return value[offset];
      const end = offset + Math.min(remaining, value.length - offset);
      if (id === SHELL_STDOUT) emit('stdout', value.subarray(offset, end));
      if (id === SHELL_STDERR) emit('stderr', value.subarray(offset, end));
      remaining -= end - offset;
      offset = end;
    }
  }
}

async function readShellOutput(socket, shellV2, signal, onOutput) {
  const reader = socket.readable.getReader();
  const cancelRead = () => { void reader.cancel().catch(noOp); };
  signal.addEventListener('abort', cancelRead, { once: true });
  const read = async () => {
    signal.throwIfAborted();
    const chunk = await reader.read();
    signal.throwIfAborted();
    return chunk;
  };
  const decoders = { stdout: new TextDecoder(), stderr: shellV2 ? new TextDecoder() : null };
  const emit = (kind, bytes, stream = true) => {
    signal.throwIfAborted();
    const text = decoders[kind].decode(bytes, { stream });
    if (text) onOutput(text, kind);
  };
  try {
    let exitCode = null;
    if (shellV2) {
      // This is a one-shot command with no input. EOF is a shell-v2 packet,
      // not a close of the whole ADB socket (legacy has no stdin half-close).
      const writer = socket.writable.getWriter();
      try {
        // A short command may finish before this write; its exit packet wins.
        void writer.write(SHELL_CLOSE_STDIN).catch(noOp);
      } finally {
        writer.releaseLock();
      }
      exitCode = await readShellV2(read, emit);
    } else {
      while (true) {
        const { done, value } = await read();
        if (done) break;
        emit('stdout', value);
      }
    }
    emit('stdout', undefined, false);
    if (shellV2) emit('stderr', undefined, false);
    return exitCode;
  } finally {
    signal.removeEventListener('abort', cancelRead);
    reader.releaseLock();
  }
}

export class AdbSession {
  #device;
  #adb;
  #controller;
  #stopWatching;
  #closing;
  #busy = false;

  constructor(device, adb, controller, stopWatching) {
    this.#device = device;
    this.#adb = adb;
    this.#controller = controller;
    const onLost = () => { void this.close().catch(noOp); };
    controller.signal.addEventListener('abort', onLost, { once: true });
    this.#stopWatching = () => {
      stopWatching();
      controller.signal.removeEventListener('abort', onLost);
    };
    void adb.disconnected.then(
      () => controller.abort(disconnected()),
      cause => controller.abort(new AdbError('disconnected', 'The ADB transport stopped.', cause)),
    );
  }

  static async connect(usb) {
    // The upstream chooser uses 0xff/0x42/0x01. Invoke it before any other await.
    const selected = await new AdbDaemonWebUsbDeviceManager(usb).requestDevice();
    if (!selected) throw new DOMException('No ADB USB device was selected.', 'NotFoundError');

    const device = selected.raw;
    const controller = new AbortController();
    const { signal } = controller;
    const onDisconnect = event => {
      if (event.device === device) controller.abort(disconnected());
    };
    usb.addEventListener('disconnect', onDisconnect);
    const stopWatching = () => usb.removeEventListener('disconnect', onDisconnect);
    let opening;
    let connection;
    let authentication;
    try {
      connection = await timed(() => (opening = selected.connect()), USB_TIMEOUT,
        new AdbError('timeout', 'Opening the ADB USB interface timed out.'), signal);
      const credentialStore = new AdbWebCredentialStore('Color Archive');
      const transport = await timed(() => (authentication = AdbDaemonTransport.authenticate({
        serial: selected.serial,
        connection,
        credentialStore,
      })), AUTH_TIMEOUT, new AdbError('adbAuthTimeout', 'Android did not authorize USB debugging in time.'), signal);
      signal.throwIfAborted();
      return new AdbSession(device, new Adb(transport), controller, stopWatching);
    } catch (error) {
      stopWatching();
      if (!connection) {
        // Even if opening completes after a deadline, release the interface.
        void opening?.then(late => closeWebUsb(device, late)).catch(noOp);
      } else if (authentication) {
        // A timed-out handshake can still finish while closing the native device.
        void authentication.then(transport => {
          void transport.disconnected.catch(noOp);
          return transport.close();
        }, () => {
          if (connection.writable.locked) return;
          return connection.writable.close();
        }).catch(noOp);
      }
      await closeWebUsb(device, connection).catch(noOp);
      // The upstream class covers any NetworkError from claimInterface, not just contention.
      if (error instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
        throw new AdbError('adbInterfaceUnavailable', 'Could not claim the ADB USB interface.', error);
      }
      throw error;
    }
  }

  get device() { return this.#device; }
  get disconnectSignal() { return this.#controller.signal; }
  get ready() { return this.#device.opened && !this.#controller.signal.aborted; }

  close() {
    if (!this.#closing) {
      this.#stopWatching();
      this.#closing = closeWithinDeadline(() => this.#adb.close()).catch(noOp)
        .then(() => closeWebUsb(this.#device));
      this.#controller.abort(disconnected());
    }
    return this.#closing;
  }

  #checkIdle() {
    if (!this.ready) throw disconnected();
    if (this.#busy) throw new AdbError('adbBusy', 'An ADB operation is already in progress.');
  }

  async #readStatus(read, timeoutMessage) {
    this.#checkIdle();
    this.#busy = true;
    const { signal } = this.#controller;
    const expired = new AdbError('timeout', timeoutMessage);
    try {
      return await timed(() => {
        signal.throwIfAborted();
        return read(signal);
      }, STATUS_TIMEOUT, expired, signal);
    } catch (error) {
      if (error === expired) await this.close().catch(noOp);
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  readBootSlot() {
    return this.#readStatus(async signal => {
      const suffix = await this.#adb.getProp('ro.boot.slot_suffix');
      signal.throwIfAborted();
      return suffix || await this.#adb.getProp('ro.boot.slot') || null;
    }, 'Reading the booted slot over ADB timed out.');
  }

  readDeviceInfo() {
    return this.#readStatus(async signal => {
      const get = async key => {
        const value = await this.#adb.getProp(key);
        signal.throwIfAborted();
        return value || null;
      };
      return {
        model: await get('ro.product.model'),
        release: await get('ro.build.version.release'),
        sdk: await get('ro.build.version.sdk'),
      };
    }, 'Reading Android device information over ADB timed out.');
  }

  async #closeShellSocket(socket) {
    try {
      await closeWithinDeadline(() => Promise.all([socket.readable.cancel(), socket.close(), socket.closed]));
    } catch {
      // A stuck close can leave the dispatcher unusable. Invalidate the USB
      // session instead of letting another operation run on it.
      void this.close().catch(noOp);
    }
  }

  async #openShellSocket(service, signal) {
    let opening;
    try {
      return await timed(() => {
        signal.throwIfAborted();
        return (opening = this.#adb.createSocket(service));
      }, SHELL_OPEN_TIMEOUT, new AdbError('timeout', 'Opening the ADB shell socket timed out.'), signal);
    } catch (error) {
      // OPEN is not abortable in the pinned transport. If it is acknowledged
      // after Stop or a timeout, close the exact socket that opened late.
      void opening?.then(socket => this.#closeShellSocket(socket)).catch(noOp);
      throw error;
    }
  }

  async runShell(command, { signal, onOutput = noOp } = {}) {
    const shellV2 = this.#adb.canUseFeature('shell_v2');
    const prefix = shellV2 ? 'shell,v2,raw:' : 'exec:';
    // OPEN must fit in one negotiated ADB payload; old daemons also need a NUL.
    const limit = Math.min(MAX_SHELL_COMMAND_BYTES, this.#adb.maxPayloadSize - prefix.length - 1);
    if (typeof command !== 'string' || command.length > limit || !command.trim() || command.includes('\0') ||
        new TextEncoder().encode(command).length > limit) {
      throw new AdbError('adbInvalidCommand', 'Enter a nonempty ADB shell command within the byte limit and without NUL characters.');
    }
    if (typeof onOutput !== 'function') throw new TypeError('onOutput must be a function.');
    signal?.throwIfAborted();
    this.#checkIdle();
    this.#busy = true;
    const sessionSignal = this.disconnectSignal;
    const operation = new AbortController();
    const abortFromSession = () => operation.abort(sessionSignal.reason);
    const abortFromCaller = () => operation.abort(signal.reason);
    sessionSignal.addEventListener('abort', abortFromSession, { once: true });
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    let socket;
    try {
      // Select before OPEN: even a failed acknowledgement is not a reason to
      // send the same command over another service.
      socket = await this.#openShellSocket(prefix + command, operation.signal);
      operation.signal.throwIfAborted();
      const exitCode = await readShellOutput(socket, shellV2, operation.signal, onOutput);
      operation.signal.throwIfAborted();
      return { exitCode };
    } catch (error) {
      operation.signal.throwIfAborted();
      throw error;
    } finally {
      sessionSignal.removeEventListener('abort', abortFromSession);
      signal?.removeEventListener('abort', abortFromCaller);
      // Closing the socket stops local output; it does not prove the Android
      // process was killed (and a legacy stream never has an exit status).
      if (socket) await this.#closeShellSocket(socket);
      this.#busy = false;
    }
  }

  async reboot(target) {
    if (!REBOOT_SERVICES.has(target)) throw new AdbError('adbInvalidTarget', 'Invalid ADB reboot target.');
    this.#checkIdle();
    this.#busy = true;
    const { signal } = this.#controller;
    let socket;
    try {
      await timed(async () => {
        // createSocket resolves only after adbd acknowledges OPEN. Any text from
        // the standard reboot service indicates a failure, not a device banner.
        socket = await this.#adb.createSocket(REBOOT_SERVICES.get(target));
        const reader = socket.readable.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            const detail = decoder.decode(value, { stream: !done }).trim();
            if (detail) throw new AdbError('adbRebootRejected', detail.slice(0, 300));
            if (done) return;
          }
        } finally {
          reader.releaseLock();
        }
      }, REBOOT_TIMEOUT, new Error('The ADB reboot service timed out.'), signal);
    } catch (error) {
      if (socket && error.code === 'disconnected' && !error.cause) return;
      if (error.code === 'adbRebootRejected') {
        void socket.close().catch(noOp);
        throw error;
      }
      // The pinned dispatcher uses this rejection for a CLSE before OPEN acknowledgement.
      if (!socket && error.message === 'Socket open failed') {
        throw new AdbError('adbRebootRejected', 'Android rejected the ADB reboot service.', error);
      }
      await this.close().catch(noOp);
      throw new AdbError('adbRebootUnconfirmed', 'The reboot could not be confirmed over ADB. Check the device.', error);
    } finally {
      this.#busy = false;
    }
    // Even a clean service end does not prove which mode Android booted into.
  }
}
