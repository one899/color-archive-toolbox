const storageKey = 'color-archive.toolbox.appearance.v1';
const schemes = ['system', 'light', 'dark'];
const defaults = { scheme: 'system', theme: '#426d8c', accent: '#6ca7d4' };

export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return '#' + hex;
  if (/^[0-9a-f]{3}$/.test(hex)) return '#' + [...hex].map(digit => digit + digit).join('');
  return null;
}

export function parseAppearance(raw) {
  let saved;
  try { saved = JSON.parse(raw); } catch { /* An invalid record uses defaults. */ }
  return {
    scheme: schemes.includes(saved?.scheme) ? saved.scheme : defaults.scheme,
    theme: normalizeHex(saved?.theme) ?? defaults.theme,
    accent: normalizeHex(saved?.accent) ?? defaults.accent,
  };
}

const rgb = hex => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
const hexOf = channels => '#' + channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('');
function mix(from, to, weight) {
  const right = rgb(to);
  return hexOf(rgb(from).map((channel, index) => channel + (right[index] - channel) * weight));
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map(channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

function contrast(a, b) {
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

function fitContrast(color, toward, surfaces, minimum) {
  const backgrounds = surfaces.map(luminance);
  const readable = candidate => {
    const value = luminance(candidate);
    return backgrounds.every(bg => contrast(value, bg) >= minimum);
  };
  if (readable(color)) return color;
  // Keep as much of the picked color as possible while meeting contrast on every surface.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 9; i++) {
    const middle = (low + high) / 2;
    if (readable(mix(color, toward, middle))) high = middle;
    else low = middle;
  }
  return mix(color, toward, high);
}

function onFill(color) {
  const value = luminance(color);
  return contrast(value, 0) >= contrast(value, 1) ? '#000000' : '#ffffff';
}

export function buildPalette(mode, themeColor, accentColor) {
  const light = mode === 'light';
  const theme = normalizeHex(themeColor) ?? defaults.theme;
  const accent = normalizeHex(accentColor) ?? defaults.accent;
  const tint = (darkBase, darkWeight, lightBase, lightWeight) => light
    ? mix(lightBase, theme, lightWeight) : mix(darkBase, theme, darkWeight);
  // Bound the base tint to keep backgrounds in the chosen mode's luminance range.
  const bg = tint('#060606', .12, '#fafafa', .14);
  const surface = tint('#0d0d0d', .16, '#ffffff', .07);
  const inset = tint('#090909', .1, '#f9f9f9', .11);
  const field = tint('#0e0e0e', .13, '#ffffff', .075);
  const control = tint('#121212', .15, '#ffffff', .095);
  const hover = tint('#1a1a1a', .16, '#f8f8f8', .115);
  const pressed = tint('#222222', .16, '#f2f2f2', .125);
  const disabled = tint('#131313', .12, '#f1f1f1', .085);
  const accentSurface = mix(surface, accent, .14);
  const toward = light ? '#000000' : '#ffffff';
  const surfaces = [bg, surface, inset, field, control, hover, pressed, disabled, accentSurface];
  const readableAccent = fitContrast(mix(accent, toward, light ? .12 : .25), toward, surfaces, 4.5);
  const fill = fitContrast(mix(accent, toward, light ? .08 : .16), toward, surfaces, 3);
  const fillHover = mix(fill, toward, .17);

  return {
    '--bg': bg,
    '--surface': surface,
    '--inset': inset,
    '--field': field,
    '--control': control,
    '--control-hover': hover,
    '--control-pressed': pressed,
    '--control-disabled': disabled,
    '--text': light ? '#202a32' : '#f0f1ed',
    '--sub': light ? '#47525c' : '#aeb7bf',
    '--muted': light ? '#4a5560' : '#a5afb8',
    '--line': tint('#2a2a2a', .16, '#c1c1c1', .12),
    '--control-border': fitContrast(tint('#808080', .09, '#686868', .09), toward, surfaces, 3),
    '--accent': readableAccent,
    '--accent-surface': accentSurface,
    '--accent-fill': fill,
    '--on-accent': onFill(fill),
    '--accent-fill-hover': fillHover,
    '--on-accent-hover': onFill(fillHover),
    '--focus': fitContrast(mix(readableAccent, toward, .17), toward, surfaces, 3),
    '--warning': light ? '#704400' : '#ffd59a',
    '--warning-border': light ? '#9b773b' : '#9b7950',
    '--warning-surface': light ? '#fff4e2' : '#201911',
    '--error': light ? '#9c2729' : '#ffb5b5',
    '--success': light ? '#145b42' : '#aadfc8',
    '--danger-fill': light ? '#a4292e' : '#edbab4',
    '--danger-fill-hover': light ? '#832326' : '#ffd6d1',
    '--on-danger': light ? '#ffffff' : '#220c0c',
    '--terminal-text': light ? '#24313a' : '#e1e9ed',
    '--backdrop': light ? 'rgb(21 28 37 / 48%)' : 'rgb(0 0 0 / 72%)',
  };
}

export function initAppearance(t) {
  const root = document.documentElement;
  const byId = id => document.getElementById(id);
  const dialog = byId('appearanceDialog');
  const trigger = byId('appearanceButton');
  const status = byId('appearanceStatus');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const options = [...dialog.querySelectorAll('input[name="toolbox-scheme"]')];
  const fields = [
    { key: 'theme', picker: byId('themeColor'), hex: byId('themeHex') },
    { key: 'accent', picker: byId('accentColor'), hex: byId('accentHex') },
  ];
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let raw;
  let storageProblem = false;
  try { raw = window.localStorage.getItem(storageKey); } catch { storageProblem = true; }
  let appearance = parseAppearance(raw);

  function apply() {
    const mode = appearance.scheme === 'system' ? (system.matches ? 'dark' : 'light') : appearance.scheme;
    const palette = buildPalette(mode, appearance.theme, appearance.accent);
    root.dataset.toolboxScheme = appearance.scheme;
    root.dataset.toolboxTheme = mode;
    for (const [property, value] of Object.entries(palette)) root.style.setProperty(property, value);
    themeMeta?.setAttribute('content', palette['--bg']);
  }

  function persist() {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(appearance));
      storageProblem = false;
    } catch { storageProblem = true; }
  }

  let wasReset = false;
  function updateStatus() {
    const invalid = fields.some(({ hex }) => hex.getAttribute('aria-invalid') === 'true');
    status.dataset.kind = invalid ? 'error' : '';
    const message = invalid ? t('请输入有效的 HEX 色值，例如 #6CA7D4。', 'Enter a valid hex color, such as #6CA7D4.')
      : wasReset ? t('已恢复默认外观。', 'Default appearance restored.') : '';
    const note = storageProblem ? t('无法保存外观，本次更改仅在此页面生效。', 'Preferences cannot be saved; changes apply to this page only.') : '';
    const text = [message, note].filter(Boolean).join(' ');
    if (status.textContent !== text) status.textContent = text;
  }

  function syncField({ key, picker, hex }) {
    picker.value = appearance[key];
    hex.value = appearance[key].toUpperCase();
    hex.removeAttribute('aria-invalid');
  }

  function syncForm() {
    for (const input of options) input.checked = input.value === appearance.scheme;
    fields.forEach(syncField);
  }

  function change(key, value) {
    wasReset = false;
    if (appearance[key] !== value) {
      appearance[key] = value;
      apply();
      persist();
    }
    updateStatus();
  }

  for (const input of options) {
    input.addEventListener('change', () => {
      if (input.checked && schemes.includes(input.value)) change('scheme', input.value);
    });
  }
  for (const field of fields) {
    const { key, picker, hex } = field;
    const pick = () => {
      const color = normalizeHex(picker.value);
      if (!color) return;
      hex.value = color.toUpperCase();
      hex.removeAttribute('aria-invalid');
      change(key, color);
    };
    picker.addEventListener('input', pick);
    picker.addEventListener('change', pick);
    hex.addEventListener('input', () => {
      const color = normalizeHex(hex.value);
      if (color) {
        hex.removeAttribute('aria-invalid');
        picker.value = color;
        change(key, color);
      } else {
        wasReset = false;
        // Incomplete values are common while typing; mark errors only on commit.
        if (hex.value.trim().length >= 6) hex.setAttribute('aria-invalid', 'true');
        else hex.removeAttribute('aria-invalid');
        updateStatus();
      }
    });
    const commit = () => {
      if (normalizeHex(hex.value)) syncField(field);
      else hex.setAttribute('aria-invalid', 'true');
      updateStatus();
    };
    hex.addEventListener('blur', commit);
    hex.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
  }

  trigger.addEventListener('click', () => {
    if (dialog.open) return;
    wasReset = false;
    syncForm();
    updateStatus();
    dialog.showModal();
    options.find(input => input.checked)?.focus();
  });
  byId('appearanceClose').addEventListener('click', () => dialog.close());
  byId('appearanceReset').addEventListener('click', () => {
    appearance = { ...defaults };
    wasReset = true;
    apply();
    persist();
    syncForm();
    updateStatus();
  });
  dialog.addEventListener('close', () => {
    if (!dialog.open) trigger.focus({ preventScroll: true });
  });

  const syncSystem = () => { if (appearance.scheme === 'system') apply(); };
  if (system.addEventListener) system.addEventListener('change', syncSystem);
  else system.addListener(syncSystem);

  apply();
  syncForm();
  updateStatus();
}
