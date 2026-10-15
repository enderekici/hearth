import fs from 'node:fs/promises';
import path from 'node:path';

export const dataDir = path.resolve(process.env.DATA_DIR || './data');
export const photoDir = path.resolve(process.env.PHOTO_DIR || './photos');
export const configPath = path.join(dataDir, 'config.json');

export const defaults = {
  location: { name: '', latitude: null, longitude: null, timezone: 'Europe/London' },
  calendarIds: [], photoAlbums: [], palette: 'linen', theme: 'auto', dayStart: '07:00', nightStart: '22:00', photoInterval: 30,
  icloud: null, spotify: { clientId: '', clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0,
    scopes: [], scopeDenied: [] },
};

export async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
}

export async function loadConfig() {
  try {
    const value = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_config');
    const config = { ...structuredClone(defaults), ...value,
      location: { ...defaults.location, ...value.location },
      spotify: { ...defaults.spotify, ...value.spotify } };
    if (!Array.isArray(config.calendarIds) || !config.calendarIds.every(x => typeof x === 'string')
        || !Array.isArray(config.photoAlbums) || !config.photoAlbums.every(x => typeof x === 'string')
        || !['linen', 'ocean', 'forest', 'ink'].includes(config.palette)
        || !['auto', 'light', 'dark'].includes(config.theme)
        || !Number.isInteger(config.photoInterval) || config.photoInterval < 5 || config.photoInterval > 3600
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.dayStart)
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.nightStart)
        || !config.spotify || typeof config.spotify.clientId !== 'string'
        || typeof config.spotify.clientSecret !== 'string' || typeof config.spotify.accessToken !== 'string'
        || typeof config.spotify.refreshToken !== 'string'
        || !Array.isArray(config.spotify.scopes) || !config.spotify.scopes.every(x => typeof x === 'string')
        || !Array.isArray(config.spotify.scopeDenied) || !config.spotify.scopeDenied.every(x => typeof x === 'string')) throw new Error('invalid_config');
    if (config.icloud && (typeof config.icloud.email !== 'string' || typeof config.icloud.password !== 'string'
        || !/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/i.test(config.icloud.password))) throw new Error('invalid_config');
    await fs.chmod(configPath, 0o600);
    return config;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return structuredClone(defaults);
  }
}

export async function saveConfig(config) {
  await ensureDataDir();
  const temp = configPath + '.' + process.pid + '.' + Date.now() + '.tmp';
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, configPath);
  const dir = await fs.open(dataDir, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

let mutationQueue = Promise.resolve();
export function mutateConfig(mutator) {
  const operation = mutationQueue.then(async () => {
    const current = await loadConfig();
    const result = await mutator(current);
    await saveConfig(current);
    return { config: current, result };
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

export function publicSettings(config) {
  return { location: config.location, calendarIds: config.calendarIds, photoAlbums: config.photoAlbums,
    palette: config.palette, theme: config.theme, dayStart: config.dayStart, nightStart: config.nightStart,
    photoInterval: config.photoInterval, spotifyClientId: config.spotify.clientId };
}
