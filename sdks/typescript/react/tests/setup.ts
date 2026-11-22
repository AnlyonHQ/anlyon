import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

configure({ asyncUtilTimeout: 4000 });

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});
