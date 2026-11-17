import assert from 'node:assert/strict';
import test from 'node:test';

import {shouldRetryHttpStatus} from '../src/lyrics/http-policy.js';

test('only rate limits and server errors are retried', () => {
    assert.equal(shouldRetryHttpStatus(404), false);
    assert.equal(shouldRetryHttpStatus(429), true);
    assert.equal(shouldRetryHttpStatus(500), true);
    assert.equal(shouldRetryHttpStatus(503), true);
});
