import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const cache = mkdtempSync(join(tmpdir(), 'lyricflow-request-bench-'));
try {
    const result = spawnSync('gjs', ['-m', fileURLToPath(new URL('./request-benchmark.js', import.meta.url))], {
        env: {...process.env, XDG_CACHE_HOME: cache, GIO_USE_VFS: 'local',
            LYRICFLOW_SERVICE_MODULE: pathToFileURL(resolve(process.argv[2])).href,
            LYRICFLOW_REQUEST_OUTPUT: resolve(process.argv[3])},
        stdio: 'inherit', timeout: 30_000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally { rmSync(cache, {recursive: true, force: true}); }
