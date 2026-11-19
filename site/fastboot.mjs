const FILTER = { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 };
const REBOOT_COMMANDS = Object.freeze({
  system: 'reboot',
  bootloader: 'reboot-bootloader',
  fastbootd: 'reboot-fastboot',
  recovery: 'reboot-recovery',
  edl: 'reboot-edl', // Vendor-dependent; never try alternate OEM commands automatically.
});
const GETVAR_PREFIX = 'getvar:';
const MAX_COMMAND_BYTES = 64;
const CONTROL_TIMEOUT = 15_000;
const TRANSFER_TIMEOUT = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class FastbootError extends Error {
  constructor(code, detail = '', extra = {}) {
    super(detail || code);
    this.name = 'FastbootError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

class DeviceRejection extends FastbootError {
  constructor(detail) { super('deviceRejected', detail); }
}


export function isFastbootVariableName(name) {
  if (typeof name !== 'string') return false;
  const token = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.exec(name);
  return token?.[0] === name && encoder.encode(GETVAR_PREFIX + name).byteLength <= MAX_COMMAND_BYTES;
}


function findInterface(device) {
  for (const config of device.configurations) {
    for (const iface of config.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== FILTER.classCode || alt.interfaceSubclass !== FILTER.subclassCode ||
            alt.interfaceProtocol !== FILTER.protocolCode) continue;
        const input = alt.endpoints.filter(ep => ep.type === 'bulk' && ep.direction === 'in');
        const output = alt.endpoints.filter(ep => ep.type === 'bulk' && ep.direction === 'out');
        if (input.length === 1 && output.length === 1) {
          return { config, iface, alt, input: input[0], output: output[0] };
        }
      }
    }
  }
  throw new FastbootError('noInterface');
}

async function timed(operation, timeout, signal) {
  signal?.throwIfAborted();
  let timer;
  let abort;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FastbootError('timeout')), timeout);
    abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), guard]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function normalizeSlot(value) {
  const match = /^_?([ab])$/i.exec(value?.trim() ?? '');
  return match ? match[1].toLowerCase() : null;
}


export class FastbootSession {
  #device;
  #input;
  #output;
  #readSize;
  #controller = new AbortController();
  #closing;
  #busy = false;

  constructor(device, input, output) {
    this.#device = device;
    this.#input = input.endpointNumber;
    this.#output = output.endpointNumber;
    // Request one packet on full-speed USB so an exact 64-byte legacy reply can complete.
    this.#readSize = Math.min(input.packetSize || 64, 256);
  }

  static async connect(usb) {
    // Call from a click handler: WebUSB needs transient user activation.
    const device = await usb.requestDevice({ filters: [{ ...FILTER }] });
    const target = findInterface(device);
    let opening;
    try {
      await timed(() => { opening = device.open(); return opening; }, CONTROL_TIMEOUT);
      if (device.configuration?.configurationValue !== target.config.configurationValue) {
        await timed(() => device.selectConfiguration(target.config.configurationValue), CONTROL_TIMEOUT);
      }
      await timed(() => device.claimInterface(target.iface.interfaceNumber), CONTROL_TIMEOUT);
      const active = device.configuration.interfaces.find(iface => iface.interfaceNumber === target.iface.interfaceNumber);
      if (active?.alternate.alternateSetting !== target.alt.alternateSetting) {
        await timed(() => device.selectAlternateInterface(target.iface.interfaceNumber, target.alt.alternateSetting), CONTROL_TIMEOUT);
      }
      return new FastbootSession(device, target.input, target.output);
    } catch (error) {
      // An open that completes after a timeout must not leave an interface claimed.
      if (!device.opened) void opening?.then(() => device.close()).catch(() => {});
      if (device.opened) await timed(() => device.close(), CONTROL_TIMEOUT).catch(() => {});
      throw error;
    }
  }

  get device() { return this.#device; }
  get ready() { return this.#device.opened && !this.#controller.signal.aborted; }

  close() {
    if (!this.#closing) {
      this.#controller.abort(new FastbootError('disconnected'));
      this.#closing = this.#device.opened ? timed(() => this.#device.close(), CONTROL_TIMEOUT) : Promise.resolve();
    }
    return this.#closing;
  }

  async #send(bytes) {
    const result = await timed(() => this.#device.transferOut(this.#output, bytes), TRANSFER_TIMEOUT, this.#controller.signal);
    if (result.status !== 'ok' || result.bytesWritten !== bytes.byteLength) {
      throw new FastbootError('usbWrite', result.status + ' (' + result.bytesWritten + '/' + bytes.byteLength + ')');
    }
  }

  async #response(expected, onInfo, timeout, { includeInfoTag = false } = {}) {
    const signal = this.#controller.signal;
    const deadline = performance.now() + timeout;
    while (true) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new FastbootError('timeout');
      const result = await timed(() => this.#device.transferIn(this.#input, this.#readSize), remaining, signal);
      signal.throwIfAborted();
      if (result.status !== 'ok' || !result.data || result.data.byteLength < 4) {
        throw new FastbootError('usbRead', result.status);
      }
      const frame = decoder.decode(result.data);
      const tag = frame.slice(0, 4);
      const message = frame.slice(4).replace(/\0+$/, '');
      if (tag === 'INFO' || tag === 'TEXT') {
        if (includeInfoTag) onInfo(message, tag);
        else onInfo(message);
        continue;
      }
      if (tag === 'FAIL') throw new DeviceRejection(message);
      if (tag !== expected) throw new FastbootError('unexpectedReply', tag);
      return message;
    }
  }

  async #command(command, expected, onInfo, timeout, options) {
    await this.#send(encoder.encode(command));
    return this.#response(expected, onInfo, timeout, options);
  }

  #assertAvailable() {
    if (this.#busy) throw new FastbootError('busy');
    if (!this.ready) throw new FastbootError('disconnected');
  }

  async #control(operation, signal) {
    this.#assertAvailable();
    this.#busy = true;
    // Close immediately on abort to invalidate any in-flight USB transfer.
    const abort = () => { void this.close().catch(() => {}); };
    try {
      signal?.addEventListener('abort', abort, { once: true });
      const result = await operation();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted || !(error instanceof DeviceRejection)) await this.close().catch(() => {});
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#busy = false;
    }
  }

  async getVariable(name, { onInfo = () => {}, signal } = {}) {
    signal?.throwIfAborted();
    if (!isFastbootVariableName(name)) throw new FastbootError('invalidVariable');
    return this.#control(
      () => this.#command(GETVAR_PREFIX + name, 'OKAY', onInfo, CONTROL_TIMEOUT, { includeInfoTag: true }),
      signal,
    );
  }

  async #optionalVar(name, onInfo) {
    try {
      return (await this.#command('getvar:' + name, 'OKAY', onInfo, CONTROL_TIMEOUT)).trim();
    } catch (error) {
      if (!(error instanceof DeviceRejection)) throw error;
      return null;
    }
  }

  async readState({ onInfo = () => {} } = {}) {
    return this.#control(async () => {
      const userspace = (await this.#optionalVar('is-userspace', onInfo))?.toLowerCase();
      const mode = userspace === 'yes' ? 'fastbootd' : userspace === 'no' ? 'bootloader' : 'fastboot';
      const slot = normalizeSlot(await this.#optionalVar('current-slot', onInfo));
      const count = await this.#optionalVar('slot-count', onInfo);
      const slotCount = count && /^[0-9]+$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null;
      return { mode, slot, slotCount };
    });
  }

  async setActiveSlot(slot, { onInfo = () => {} } = {}) {
    if (slot !== 'a' && slot !== 'b') throw new FastbootError('invalidSlot');
    return this.#control(async () => {
      await this.#command('set_active:' + slot, 'OKAY', onInfo, CONTROL_TIMEOUT);
      try {
        return normalizeSlot(await this.#optionalVar('current-slot', onInfo));
      } catch (error) {
        error.slotAcknowledged = true;
        throw error;
      }
    });
  }

  async reboot(target, { onInfo = () => {} } = {}) {
    if (!Object.hasOwn(REBOOT_COMMANDS, target)) throw new FastbootError('invalidRebootTarget');
    return this.#control(async () => {
      await this.#command(REBOOT_COMMANDS[target], 'OKAY', onInfo, CONTROL_TIMEOUT);
      return { acknowledged: true };
    });
  }

}
