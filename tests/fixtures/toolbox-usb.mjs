export function adbShellFrame(id, data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const frame = new Uint8Array(5 + bytes.length);
  frame[0] = id;
  new DataView(frame.buffer).setUint32(1, bytes.length, true);
  frame.set(bytes, 5);
  return frame;
}

// Shared by the Node protocol tests and the isolated browser tests.
// Passing this object to the adapter prevents any native USB access.
export function createToolboxUsbMock() {
  const usb = new EventTarget();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = {
    filters: [], adbPackets: [], adbServices: [], fastbootCommands: [],
    authorizeAdb: false, adbAuth: [], adbClaimError: null, cancel: false, slot: 'a', bootSlot: 'b',
    fastbootd: false, rejectReboot: false,
    rejectEdl: true, holdReboot: false,
    adbFeatures: [], adbShellStdin: [],
    deviceInfo: { model: 'Mock ADB', release: '14', sdk: '34' },
    holdShellOpen: false, holdShell: false, holdShellClose: false, rejectShellOpen: false,
  };
  let approveAdb;

  function createDevice(name, protocol, receive) {
    const queued = [];
    const readers = [];
    const alternate = {
      alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 66, interfaceProtocol: protocol,
      endpoints: [
        { direction: 'in', type: 'bulk', endpointNumber: 3, packetSize: 512 },
        { direction: 'out', type: 'bulk', endpointNumber: 6, packetSize: 512 },
      ],
    };
    const iface = { interfaceNumber: 4, claimed: false, alternate, alternates: [alternate] };
    const configuration = { configurationValue: 1, interfaces: [iface] };
    const device = {
      productName: name, serialNumber: 'QA-' + protocol, vendorId: 0x18d1, productId: protocol,
      configurations: [configuration], configuration: null, opened: false,
      async open() { this.opened = true; },
      async selectConfiguration(value) {
        if (value !== 1) throw new Error('Incorrect USB configuration');
        this.configuration = configuration;
      },
      async claimInterface(value) {
        if (value !== 4 || !this.opened) throw new Error('Incorrect USB interface');
        if (protocol === 1 && state.adbClaimError) throw new DOMException('Mock interface claim failed', state.adbClaimError);
        iface.claimed = true;
      },
      async close() {
        this.opened = false;
        iface.claimed = false;
        queued.length = 0;
        for (const reader of readers.splice(0)) reader.reject(new DOMException('Mock USB closed', 'InvalidStateError'));
      },
      async transferIn(endpoint, length) {
        if (!this.opened || !iface.claimed || endpoint !== 3) throw new Error('Incorrect USB read endpoint');
        const bytes = queued.length ? queued.shift() : await new Promise((resolve, reject) => readers.push({ resolve, reject }));
        if (bytes.length > length) throw new Error('Mock reply exceeds requested length');
        // WebUSB returns a buffer for this transfer, not a view of a larger packet.
        return { status: 'ok', data: new DataView(bytes.slice().buffer) };
      },
      async transferOut(endpoint, source) {
        if (!this.opened || !iface.claimed || endpoint !== 6) throw new Error('Incorrect USB write endpoint');
        const bytes = ArrayBuffer.isView(source)
          ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
        receive(bytes);
        return { status: 'ok', bytesWritten: bytes.length };
      },
    };
    function send(bytes) {
      const reader = readers.shift();
      if (reader) reader.resolve(bytes);
      else queued.push(bytes);
    }
    function disconnect() {
      const event = new Event('disconnect');
      Object.defineProperty(event, 'device', { value: device });
      usb.dispatchEvent(event);
      void device.close();
    }
    return { device, send, disconnect };
  }

  let adbHeader;
  let nextRemoteId = 10;
  const waitingClose = new Map();
  const shells = new Map();
  const EMPTY = new Uint8Array();
  function sendAdb(command, arg0, arg1, payload = EMPTY) {
    const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
    const header = new Uint8Array(24);
    header.set(encoder.encode(command));
    const view = new DataView(header.buffer);
    view.setUint32(4, arg0, true);
    view.setUint32(8, arg1, true);
    view.setUint32(12, bytes.length, true);
    view.setUint32(16, bytes.reduce((sum, value) => sum + value, 0), true);
    view.setUint32(20, ~view.getUint32(0, true), true);
    // Let the host finish processing its USB write before the daemon replies.
    setTimeout(() => {
      if (!adb.device.opened) return;
      adb.send(header);
      if (bytes.length) adb.send(bytes);
    }, 0);
  }
  const sendBanner = () => sendAdb('CNXN', state.adbProtocolVersion ?? 0x01000001, state.adbMaxPayload ?? 4096,
    'device::ro.product.model=Mock ADB;features=' + state.adbFeatures.join(','));

  function closeShell(shell) {
    shell.closing = true;
    sendAdb('CLSE', shell.remote, shell.local);
  }

  function sendNextShellChunk(shell) {
    if (!shell.open || shell.waiting || shell.closing || shell.hostClosed) return;
    if (shell.chunks.length) {
      shell.waiting = true;
      sendAdb('WRTE', shell.remote, shell.local, shell.chunks.shift());
    } else if (shell.finish) closeShell(shell);
  }

  function acceptShell(shell) {
    if (shell.open) throw new Error('Mock shell already open');
    shell.open = true;
    sendAdb('OKAY', shell.remote, shell.local);
    sendNextShellChunk(shell);
  }

  function lastShell() {
    const shell = [...shells.values()].at(-1);
    if (!shell) throw new Error('No ADB shell pending');
    return shell;
  }
  const adb = createDevice('Mock ADB', 1, bytes => {
    if (!bytes.length) return;
    let payload = EMPTY;
    if (adbHeader) {
      if (bytes.length !== adbHeader.length) throw new Error('Incorrect ADB payload length');
      payload = bytes;
    } else {
      if (bytes.length !== 24) throw new Error('Incorrect ADB header length');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      if (view.getUint32(20, true) !== (~view.getUint32(0, true) >>> 0)) throw new Error('Incorrect ADB magic');
      adbHeader = {
        command: decoder.decode(bytes.subarray(0, 4)), arg0: view.getUint32(4, true),
        arg1: view.getUint32(8, true), length: view.getUint32(12, true),
      };
      if (adbHeader.length) return;
    }
    const { command, arg0, arg1 } = adbHeader;
    adbHeader = undefined;
    const text = decoder.decode(payload).replace(/\0+$/, '');
    state.adbPackets.push({ command, arg0, arg1, length: payload.length });
    if (command === 'CNXN') {
      waitingClose.clear();
      shells.clear();
      if (state.authorizeAdb) {
        sendAdb('AUTH', 1, 0, Uint8Array.from({ length: 20 }, (_, i) => i + 1));
      } else sendBanner();
    } else if (command === 'AUTH') {
      state.adbAuth.push({ type: arg0, length: payload.length });
      if (arg0 !== 2 && arg0 !== 3) throw new Error('Unexpected ADB auth response');
      approveAdb = sendBanner;
    } else if (command === 'OPEN') {
      state.adbServices.push(text);
      const props = {
        'exec:getprop ro.boot.slot_suffix': state.bootSlotSuffix,
        'exec:getprop ro.boot.slot': state.bootSlot,
        'exec:getprop ro.product.model': state.deviceInfo.model,
        'exec:getprop ro.build.version.release': state.deviceInfo.release,
        'exec:getprop ro.build.version.sdk': state.deviceInfo.sdk,
      };
      if (text.startsWith('reboot:')) {
        if (state.holdReboot) return;
        if (state.rejectReboot) { sendAdb('CLSE', 0, arg0); return; }
        const remote = nextRemoteId++;
        sendAdb('OKAY', remote, arg0);
        if (state.rebootError) {
          waitingClose.set(arg0, remote);
          sendAdb('WRTE', remote, arg0, state.rebootError);
        } else sendAdb('CLSE', remote, arg0);
      } else if (Object.hasOwn(props, text)) {
        const remote = nextRemoteId++;
        sendAdb('OKAY', remote, arg0);
        const value = props[text];
        if (value) {
          waitingClose.set(arg0, remote);
          sendAdb('WRTE', remote, arg0, value + '\n');
        } else sendAdb('CLSE', remote, arg0);
      } else if (text.startsWith('shell,v2,raw:') || text.startsWith('exec:')) {
        if (state.rejectShellOpen) { sendAdb('CLSE', 0, arg0); return; }
        const shellV2 = text.startsWith('shell,v2,raw:');
        const chunks = state.adbShellChunks ?? (shellV2
          ? [adbShellFrame(1, 'Mock shell\n'), ...(state.holdShell ? [] : [adbShellFrame(3, Uint8Array.of(0))])]
          : ['Mock shell\n']);
        const shell = { local: arg0, remote: nextRemoteId++, shellV2, chunks: [...chunks], finish: !state.holdShell };
        shells.set(arg0, shell);
        if (!state.holdShellOpen) acceptShell(shell);
      } else throw new Error('Unexpected ADB service: ' + text);
    } else if (command === 'OKAY') {
      const shell = shells.get(arg0);
      if (shell) {
        shell.waiting = false;
        sendNextShellChunk(shell);
      }
      const remote = waitingClose.get(arg0);
      if (remote) { waitingClose.delete(arg0); sendAdb('CLSE', remote, arg0); }
    } else if (command === 'WRTE' && shells.has(arg0)) {
      const shell = shells.get(arg0);
      state.adbShellStdin.push(payload.slice());
      if (!shell.closing && !shell.hostClosed) sendAdb('OKAY', shell.remote, shell.local);
    } else if (command === 'CLSE') {
      const shell = shells.get(arg0);
      if (shell) {
        shell.hostClosed = true;
        if (!shell.closing && !state.holdShellClose) closeShell(shell);
      }
    } else throw new Error('Unexpected ADB command: ' + command);
  });


  const reply = message => fastboot.send(encoder.encode(message));
  const fastboot = createDevice('Mock Fastboot', 3, bytes => {
    const command=decoder.decode(bytes);
    state.fastbootCommands.push(command);
    if(command==='getvar:product') reply('OKAYqa-phone');
    else if(command==='getvar:is-userspace') reply(state.fastbootd?'OKAYyes':'OKAYno');
    else if(command==='getvar:current-slot') reply('OKAY'+state.slot);
    else if(command==='getvar:slot-count') reply('OKAY2');
    else if(command==='getvar:all') {
      reply('INFOproduct: qa-phone');reply('TEXTslot ');reply('TEXTdetail\n');
      if(!state.holdVariable)reply('OKAY');
    }else if(/^set_active:[ab]$/.test(command)){state.slot=command.at(-1);reply('OKAY');}
    else if(command==='reboot-edl'&&state.rejectEdl)reply('FAILunsupported');
    else if(['reboot','reboot-bootloader','reboot-fastboot','reboot-recovery','reboot-edl'].includes(command)){
      if(state.rejectReboot){reply('FAILunsupported');return;}
      if(state.holdReboot)return;
      if(command==='reboot-fastboot')state.fastbootd=true;
      if(command==='reboot-bootloader')state.fastbootd=false;
      reply('OKAY');
    }else if(command.startsWith('getvar:'))reply('FAILUnknown variable');
    else throw new Error('Unsupported mock command');
  });
  usb.requestDevice=async({filters})=>{
    const [filter]=filters;
    if(filters.length!==1||filter.classCode!==255||filter.subclassCode!==66||![1,3].includes(filter.protocolCode))throw new Error('Incorrect USB filter');
    state.filters.push({...filter});
    if(state.cancel)throw new DOMException('Cancelled mock chooser','NotFoundError');
    return(filter.protocolCode===1?adb:fastboot).device;
  };
  return {
    usb,state,adb,fastboot,
    acceptShell(){acceptShell(lastShell());},
    sendShellChunk(bytes){const shell=lastShell();shell.chunks.push(bytes);sendNextShellChunk(shell);},
    finishShell(exitCode=0){const shell=lastShell();if(shell.shellV2)shell.chunks.push(adbShellFrame(3,Uint8Array.of(exitCode)));shell.finish=true;sendNextShellChunk(shell);},
    acknowledgeShellClose(){closeShell(lastShell());},
    acceptAdb(){if(!approveAdb)throw new Error('No authorization pending');approveAdb();approveAdb=undefined;},
  };
}
