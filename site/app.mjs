import { FastbootSession, normalizeSlot } from './fastboot.mjs';
import { AdbSession } from './adb.mjs';
import { createDeviceConsole } from './adb-console.mjs';
import { initAppearance } from './appearance.mjs';

const english = new URLSearchParams(location.search).get('lang') === 'en';
const t = (zh, en) => english ? en : zh;
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
if (english) {
  document.documentElement.lang = 'en';
  for (const element of document.querySelectorAll('[data-en]')) element.textContent = element.dataset.en;
  for (const element of document.querySelectorAll('[data-en-label]')) element.setAttribute('aria-label', element.dataset.enLabel);
  for (const element of document.querySelectorAll('[data-en-placeholder]')) element.placeholder = element.dataset.enPlaceholder;
  ui.languageSwitch.href = './';
  ui.languageSwitch.lang = ui.languageSwitch.hreflang = 'zh-CN';
  ui.languageSwitch.textContent = '中文';
}
initAppearance(t);
const modes = { adb:'ADB', fastboot:'Fastboot', bootloader:'Bootloader (FB)', fastbootd:'fastbootd (FBD)' };
const clock = new Intl.DateTimeFormat(english ? 'en-GB' : 'zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
let usb;
try { if (isSecureContext && navigator.usb?.requestDevice) usb = navigator.usb; } catch {}
let connection = null;
let activity = null;
let review = null;
const workbench = ui.main;
const navigation = new Map([...workbench.querySelectorAll('[data-view]')].map(button => [button.dataset.view, {button,panel:ui[button.getAttribute('aria-controls')]}]));
function showView(requested, updateUrl = false) {
  const target = requested === 'adb' ? 'terminal' : requested;
  const view = navigation.has(target) ? target : 'device';
  for (const [name,{button,panel}] of navigation) {
    panel.hidden = name !== view;
    if (panel.hidden) button.removeAttribute('aria-current');
    else button.setAttribute('aria-current','page');
  }
  ui.languageSwitch.hash = view === 'device' ? '' : view;
  if (updateUrl) { const url = new URL(location.href); url.hash=view; history.pushState(null,'',url); window.scrollTo(0,0); }
}
for (const [name,{button}] of navigation) button.addEventListener('click', () => showView(name,true));
window.addEventListener('hashchange', () => { if(location.hash!=='#main') showView(location.hash.slice(1)); });
ui.railToggle.addEventListener('click', () => {
  const compact=workbench.toggleAttribute('data-compact');
  ui.railToggle.setAttribute('aria-expanded',String(!compact));
  ui.railToggle.setAttribute('aria-label',compact?t('展开侧栏','Expand sidebar'):t('收起侧栏','Collapse sidebar'));
});
function openTerminal() { showView('terminal',true);ui.adbTitle.focus({preventScroll:true}); }
ui.openAdbView.addEventListener('click',openTerminal);
const deviceConsole=createDeviceConsole({ui,t,showTerminal:openTerminal,getLink:()=>isCurrent(connection)?connection:null,
  canRun:()=>!activity&&!review,formatError:errorText,
  reviewControl:({kind,target,display})=>openControl(kind,target,display),
  onBusyChange(busy){activity=busy?'terminal':null;if(!busy&&connection&&!connection.session.ready)connection=null;
    status(busy?t('执行中…','Running…'):isCurrent(connection)?t('终端已就绪。','Terminal ready.'):t('设备已断开。','Device disconnected.'));render();}
});
function safeText(value){return String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,300).trim();}
const usbId=device=>[device.vendorId,device.productId].map(value=>Number(value??0).toString(16).padStart(4,'0')).join(':');
function identify(device){return [safeText(device.productName)||'USB '+usbId(device),safeText(device.serialNumber)].filter(Boolean).join(' · ');}
function log(message,kind=''){const item=document.createElement('li');item.dataset.kind=kind;item.textContent='['+clock.format(new Date())+'] '+message;ui.logEntries.append(item);if(ui.logEntries.children.length>160)ui.logEntries.firstElementChild.remove();ui.clearLogButton.disabled=false;}
function status(message,kind=''){ui.operationStatus.textContent=message;ui.operationStatus.dataset.kind=kind;}
function report(message,kind=''){status(message,kind);log(message,kind);}
const onInfo=raw=>{const message=safeText(raw);if(message)log(t('设备：','Device: ')+message);};
const isCurrent=link=>!!link&&connection===link&&link.session.ready;
const canSwitch=link=>link?.kind==='fastboot'&&(link.state.slotCount===2||(link.state.slotCount===null&&!!link.state.slot));
const modeName=link=>modes[link.state.mode];
const slotName=slot=>t(slot.toUpperCase()+' 槽','Slot '+slot.toUpperCase());
function errorText(error){
  const messages={disconnected:t('设备已断开。','Device disconnected.'),timeout:t('等待设备响应超时。','Device response timed out.'),adbAuthTimeout:t('USB 调试授权超时，请解锁手机后重连。','USB debugging approval timed out. Unlock the phone and reconnect.'),adbInterfaceUnavailable:t('ADB 接口无法打开。请关闭其他占用设备的工具后重连。','ADB interface unavailable. Close other tools using the device and reconnect.'),deviceRejected:t('设备拒绝指令','Device rejected the command'),adbRebootRejected:t('设备拒绝重启','Device rejected reboot'),adbRebootUnconfirmed:t('重启结果未确认，请检查手机。','Reboot was not confirmed. Check the phone.'),noInterface:t('设备未提供标准 Fastboot 接口。','No standard Fastboot interface was found.'),busy:t('设备正忙。','The device is busy.')};
  const message=messages[error?.code]||t('设备操作失败','Device operation failed');
  return error?.code==='deviceRejected'?message+': '+safeText(error.detail):message;
}
function closeReview(){review=null;if(ui.controlDialog.open)ui.controlDialog.close();}

function render() {
  const link = isCurrent(connection) ? connection : null;
  const slot = link?.state.slot;
  const switching = canSwitch(link);
  ui.connectionStatus.textContent = activity === 'connecting' ? t('正在连接…', 'Connecting…')
    : activity === 'disconnecting' ? t('正在断开…', 'Disconnecting…')
    : link ? t('已连接', 'Connected') : t('未连接', 'Not connected');
  const working = activity === 'connecting' || activity === 'disconnecting';
  ui.connectionStatus.dataset.state = working ? 'working' : link ? 'connected' : 'offline';
  const device = link?.session.device;
  const info = link?.state.info;
  const isAdb = link?.kind === 'adb';
  const model = safeText(info?.model);
  const release = safeText(info?.release);
  const sdk = safeText(info?.sdk);
  ui.deviceName.textContent = device ? model || safeText(device.productName) || 'USB ' + usbId(device) : t('等待设备', 'Waiting for a device');
  ui.deviceName.title = device ? identify(device) : '';
  ui.deviceUsbId.textContent = device ? usbId(device) : '—';
  ui.deviceSerial.textContent = safeText(device?.serialNumber) || '—';
  ui.deviceModel.textContent = model || '—';
  ui.deviceAndroid.textContent = [release, sdk ? 'API ' + sdk : ''].filter(Boolean).join(' · ') || '—';
  ui.deviceModel.parentElement.hidden = ui.deviceAndroid.parentElement.hidden = !!link && !isAdb;
  ui.deviceHelp.textContent = isAdb ? t('已授权 USB 调试。可以打开 ADB 终端或选择重启目标。', 'USB debugging authorized. Open the ADB terminal or choose a reboot target.')
    : link ? t('已连接 Fastboot。打开终端查询设备信息。', 'Fastboot connected. Open the terminal to query device information.')
      : t('使用 ADB 时，请解锁手机、开启 USB 调试并确认授权。', 'Unlock the phone, turn on USB debugging and approve the prompt to use ADB.');
  ui.deviceMode.textContent = link ? modeName(link) : '—';
  ui.slotLabel.textContent = link?.kind === 'adb' ? t('当前运行槽', 'Booted slot')
    : link?.kind === 'fastboot' ? t('活动槽', 'Active slot') : t('槽位', 'Slot');
  ui.deviceSlot.textContent = slot ? slotName(slot) : !link ? '—'
    : link.state.slotCount === 1 || link.state.slotCount === 0 ? t('不适用', 'Not applicable') : t('未知', 'Unknown');
  ui.slotHint.textContent = switching ? t('切槽后将在下次启动时使用目标槽。', 'The selected slot will be used on the next boot.')
    : link?.kind === 'fastboot' ? t('未检测到可切换的 A/B 槽。', 'Switchable A/B slots were not detected.')
      : t('切换活动槽需要 Fastboot。', 'Switching the active slot requires Fastboot.');
  ui.connectButton.disabled = !usb || !!activity || !!link;
  ui.connectButton.hidden = ui.connectAdbButton.hidden = !!link;
  ui.disconnectButton.hidden = !link;
  const locked = !!activity;
  ui.connectAdbButton.disabled = !usb || !AdbSession || locked || !!link;
  ui.disconnectButton.disabled = !!activity || !link;
  ui.readDeviceButton.disabled = locked || !link;
  ui.slotAButton.disabled = locked || !switching || slot === 'a';
  ui.slotBButton.disabled = locked || !switching || slot === 'b';
  ui.rebootTarget.disabled = locked || !link;
  ui.rebootButton.disabled = locked || !link || !ui.rebootTarget.value;
  deviceConsole.render();
}


async function readState(link) {
  let state;
  if (link.kind === 'adb') {
    const slot = normalizeSlot(await link.session.readBootSlot());
    const info = await link.session.readDeviceInfo().catch(() => null);
    state = { mode: 'adb', slot, slotCount: null, info };
  } else {
    state = await link.session.readState({ onInfo });
  }
  if (!isCurrent(link)) throw Object.assign(new Error(), { code: 'disconnected' });
  link.state = state;
  return state;
}

async function refresh(link) {
  try {
    const { slot } = await readState(link);
    const label = link.kind === 'adb' ? t('运行槽：', 'Booted slot: ') : t('活动槽：', 'Active slot: ');
    report(modeName(link) + ' · ' + label + (slot ? slotName(slot) : t('未知', 'Unknown')));
  } catch (error) {
    link.state = { mode: link.kind, slot: null, slotCount: null };
    if (connection === link && !link.session.ready) connection = null;
    report(t('未能读取设备状态。', 'Could not read device status. ') + errorText(error), 'error');
  }
}

async function connect(kind, Session) {
  if (!usb || !Session || activity || isCurrent(connection)) return;
  activity = 'connecting';
  render();
  status(kind === 'adb'
    ? t('请选择 ADB 设备，并在手机上确认 USB 调试授权。', 'Select the ADB device, then approve USB debugging on the phone.')
    : t('请选择 Fastboot 设备。', 'Select a Fastboot device.'));
  let selectedSession;
  try {
    // connect() opens the browser's chooser under this click's user activation.
    selectedSession = await Session.connect(usb);
    if (!selectedSession.ready) throw Object.assign(new Error(), { code: 'disconnected' });
    const link = { session: selectedSession, kind, state: { mode: kind, slot: null, slotCount: null } };
    connection = link;
    if (kind === 'adb') {
      selectedSession.disconnectSignal.addEventListener('abort', () => handleConnectionLost(link), { once: true });
    }
    ui.rebootTarget.value = '';
    log(t('已连接：', 'Connected: ') + identify(selectedSession.device));
    status(t('正在读取设备状态…', 'Reading device status…'));
    await refresh(link);
  } catch (error) {
    connection = null;
    if (selectedSession) await selectedSession.close().catch(() => {});
    if (error.name === 'NotFoundError') {
      status(kind === 'adb'
        ? t('未选中 ADB 设备。若列表为空，请解锁被控手机、检查 USB 调试和数据线；手机当主机时请检查 OTG。', 'No ADB device selected. If the chooser is empty, unlock the target phone and check USB debugging and the cable. Check OTG if using a phone as the host.')
        : t('未选中 Fastboot 设备。请确认手机处于 Fastboot 或 fastbootd。', 'No Fastboot device selected. Check that the phone is in Fastboot or fastbootd.'));
    } else {
      const guidance = error.code === 'adbInterfaceUnavailable' ? '' : t(
        ' 请检查数据线和驱动，并关闭其他占用设备的工具。',
        ' Check the cable and driver, and close other tools using the device.',
      );
      report(errorText(error) + guidance, 'error');
    }
  } finally {
    activity = null;
    render();
  }
}


ui.connectButton.addEventListener('click', () => void connect('fastboot', FastbootSession));
ui.connectAdbButton.addEventListener('click', () => void connect('adb', AdbSession));
ui.readDeviceButton.addEventListener('click', async () => {
  if (activity || !isCurrent(connection)) return;
  activity = 'reading';
  render();
  status(t('正在读取设备状态…', 'Reading device status…'));
  try { await refresh(connection); }
  finally { activity = null; render(); }
});

ui.disconnectButton.addEventListener('click', async () => {
  if (activity || !isCurrent(connection)) return;
  const link = connection;
  connection = null;
  closeReview();
  activity = 'disconnecting';
  render();
  try {
    await link.session.close();
    report(t('已断开连接。', 'Device disconnected.'));
  } catch (error) {
    report(errorText(error), 'error');
  } finally {
    activity = null;
    render();
  }
});

function handleConnectionLost(link) {
  if (connection !== link) return;
  connection = null;
  closeReview();
  void link.session.close().catch(() => {});
  const message = t('设备连接已断开。', 'Device connection closed.');
  if (!activity) status(message, 'error');
  log(message, activity === 'reboot' ? '' : 'error');
  render();
}

usb?.addEventListener('disconnect', event => {
  const link = connection;
  if (link?.session.device === event.device) handleConnectionLost(link);
});

function openControl(kind, target, terminalCommand = null) {
  const link = connection;
  if (activity || review || !isCurrent(link)) return false;
  if (kind === 'slot' && (!canSwitch(link) || !['a', 'b'].includes(target) || link.state.slot === target)) return false;
  const rebootOption = [...ui.rebootTarget.options].find(option => option.value && option.value === target);
  if (kind === 'reboot' && !rebootOption) return false;
  review = { kind, target, link, terminalCommand, label: kind === 'slot' ? slotName(target) : rebootOption.textContent };
  ui.controlTitle.textContent = kind === 'slot' ? t('确认切换活动槽', 'Confirm active slot change') : t('确认重启', 'Confirm reboot');
  ui.controlWarning.textContent = kind === 'slot'
    ? t('目标槽将在下次启动时使用。确认目标槽可启动；此操作不会自动重启。', 'The target slot will be used on next boot. Check that it is bootable. This does not reboot the device.')
    : target === 'edl'
      ? t('仅设备支持时才能进入 9008。进入后会断开 ADB/Fastboot，网页不能在 9008 模式刷机。', '9008 requires device support. ADB/Fastboot disconnects in that mode; this page cannot flash in 9008.')
      : t('重启会断开当前连接。请在手机确认目标模式，再按需重新连接。', 'Rebooting disconnects the current session. Confirm the destination on the phone before reconnecting.');
  ui.controlDevice.textContent = identify(link.session.device);
  ui.controlTarget.textContent = review.label;
  ui.controlDialog.showModal();
  return true;
}

ui.rebootTarget.addEventListener('change', render);
ui.rebootButton.addEventListener('click', () => openControl('reboot', ui.rebootTarget.value));
ui.slotAButton.addEventListener('click', () => openControl('slot', 'a'));
ui.slotBButton.addEventListener('click', () => openControl('slot', 'b'));
ui.cancelControl.addEventListener('click', closeReview);
ui.controlDialog.addEventListener('close', () => { if (!ui.controlDialog.open) review = null; render(); });


ui.confirmControl.addEventListener('click', async () => {
  const pending = review;
  if (!ui.controlDialog.open || !pending) return;
  closeReview();
  const { link, kind, target, label, terminalCommand } = pending;
  if (activity || !isCurrent(link)) return;
  activity = kind;
  const feedback = terminalCommand ? text => {
    onInfo(text);
    deviceConsole.controlInfo(text);
  } : onInfo;
  const finish = (message, level) => {
    report(message, level);
    if (terminalCommand) deviceConsole.controlResult(message, level);
  };
  if (terminalCommand) deviceConsole.startControl(terminalCommand);
  render();
  status(kind === 'slot' ? t('正在切换活动槽…', 'Switching active slot…') : t('正在提交重启请求…', 'Sending reboot request…'));
  try {
    if (kind === 'slot') {
      const active = await link.session.setActiveSlot(target, { onInfo: feedback });
      link.state.slot = active;
      if (active === target) finish(t('已确认活动槽：', 'Active slot confirmed: ') + label, 'success');
      else if (active) finish(t('请求已接受，但设备仍报告：', 'Request accepted, but the device reports: ') + slotName(active), 'error');
      else finish(t('切槽命令已确认，未能回读活动槽。', 'Slot change acknowledged, but the active slot could not be read back.'), 'error');
    } else {
      const result = await link.session.reboot(target, { onInfo: feedback });
      if (link.kind === 'fastboot' && !result?.acknowledged) {
        throw new Error(t('设备未确认重启请求。', 'The device did not acknowledge the reboot request.'));
      }
      if (connection === link) connection = null;
      await link.session.close().catch(() => {});
      finish(t('设备已确认重启请求：', 'Device acknowledged reboot request: ') + label +
        t('。是否到达目标模式，请在手机上确认。', '. Check the phone to confirm the destination.'), 'success');
    }
  } catch (error) {
    if (kind === 'slot' && error?.code !== 'deviceRejected') link.state.slot = null;
    if (connection === link && !link.session.ready) connection = null;
    const message = errorText(error);
    const rejected = error?.code === 'deviceRejected' || error?.code === 'adbRebootRejected';
    const unconfirmed = kind === 'reboot' && !rejected && error?.code !== 'adbRebootUnconfirmed';
    finish(unconfirmed ? t('重启结果未确认。', 'Reboot not confirmed. ') + message
      : error?.slotAcknowledged ? t('切槽命令已确认，未能回读活动槽。', 'Slot change acknowledged, but the active slot could not be read back.') : message, 'error');
  } finally {
    activity = null;
    render();
  }
});


ui.clearLogButton.addEventListener('click',()=>{ui.logEntries.replaceChildren();ui.clearLogButton.disabled=true;});
if(!usb){ui.supportNotice.hidden=false;ui.supportNotice.textContent=isSecureContext?t('此浏览器不支持 WebUSB，请用 Chrome 或 Edge。','WebUSB is unavailable. Use Chrome or Edge.'):t('请通过 HTTPS 或 localhost 打开。','Open over HTTPS or localhost.');}
ui.clearLogButton.disabled=true;
showView(location.hash.slice(1));
render();
