import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const cache = mkdtempSync(join(tmpdir(), 'lyricflow-test-'));
try {
    const result = spawnSync('dbus-run-session', ['--', 'gjs', '-m',
        fileURLToPath(new URL('./runtime-test.js', import.meta.url))], {
        env: {...process.env, XDG_CACHE_HOME: cache, GIO_USE_VFS: 'local'},
        stdio: 'inherit', timeout: 30_000,
    });
    if (result.error)
        throw result.error;
    process.exitCode = result.status ?? 1;
} finally {
    rmSync(cache, {recursive: true, force: true});
}
