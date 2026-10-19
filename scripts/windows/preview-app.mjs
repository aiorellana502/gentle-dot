import { join, win32 } from 'node:path';
import { launch, startDetached } from './local-app.mjs';

// Reuse prerequisite checks and the environment allowlist, not the owner's profile.
export async function launchPreview(root, base, spawnApp = startDetached) {
  return launch(root, base, (exe, args, options) => {
    const data = join(root, '.cache/windows-preview');
    const home = join(data, 'launcher-home');
    const drive = win32.parse(home).root.replace(/\\$/, '');
    return spawnApp(exe, args, { ...options, env: {
      ...options.env,
      GENTLE_DOT_DATA_DIR: data,
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: drive,
      HOMEPATH: home.slice(drive.length),
      APPDATA: join(home, 'AppData/Roaming'),
      LOCALAPPDATA: join(home, 'AppData/Local'),
    } });
  });
}
