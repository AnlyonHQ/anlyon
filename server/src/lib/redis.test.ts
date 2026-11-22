import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('ioredis', () => {
  return {
    Redis: class MockRedis {
      options: any;
      constructor(url: string, options?: any) {
        this.options = options;
      }
      on = vi.fn();
      ping = vi.fn().mockResolvedValue('PONG');
      quit = vi.fn().mockResolvedValue(undefined);
      set = vi.fn().mockResolvedValue('OK');
      get = vi.fn().mockResolvedValue(null);
      del = vi.fn().mockResolvedValue(1);
      eval = vi.fn().mockResolvedValue(1);
      smembers = vi.fn().mockResolvedValue([]);
      sadd = vi.fn().mockResolvedValue(1);
      srem = vi.fn().mockResolvedValue(1);
      zrangebyscore = vi.fn().mockResolvedValue([]);
      zcard = vi.fn().mockResolvedValue(0);
      keys = vi.fn().mockResolvedValue([]);
      xreadgroup = vi.fn().mockResolvedValue(null);
      pipeline = vi.fn(() => ({
        incrby: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        hset: vi.fn().mockReturnThis(),
        zrange: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }));
    },
  };
});

import { redis, redisBlocking, RedisKeys, checkRedisHealth, closeRedis, checkPipelineResults, execPipelineChecked } from './redis';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RedisKeys', () => {
  describe('pendingStream', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.pendingStream('workspace-123');
      expect(key).toBe('workspace:workspace-123:stream:pending');
    });
  });

  describe('scheduledSet', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.scheduledSet('workspace-456');
      expect(key).toBe('workspace:workspace-456:zset:scheduled');
    });
  });

  describe('processingSet', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.processingSet('workspace-789');
      expect(key).toBe('workspace:workspace-789:zset:processing');
    });
  });

  describe('dlqSet', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.dlqSet('workspace-abc');
      expect(key).toBe('workspace:workspace-abc:zset:dlq');
    });
  });

  describe('activeWorkspacesPending', () => {
    it('should return index key', () => {
      const key = RedisKeys.activeWorkspacesPending();
      expect(key).toBe('index:workspaces:pending');
    });
  });

  describe('activeWorkspacesScheduled', () => {
    it('should return index key', () => {
      const key = RedisKeys.activeWorkspacesScheduled();
      expect(key).toBe('index:workspaces:scheduled');
    });
  });

  describe('activeWorkspacesProcessing', () => {
    it('should return index key', () => {
      const key = RedisKeys.activeWorkspacesProcessing();
      expect(key).toBe('index:workspaces:processing');
    });
  });

  describe('message', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.message('ws-1', 'msg-123');
      expect(key).toBe('workspace:ws-1:messages:msg-123');
    });
  });

  describe('contentHash', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.contentHash('ws-1', 'abc123');
      expect(key).toBe('workspace:ws-1:dedup:abc123');
    });
  });

  describe('usageCounter', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.usageCounter('ws-1', '2025-01-01', 'messages_sent');
      expect(key).toBe('workspace:ws-1:usage:2025-01-01:messages_sent');
    });
  });

  describe('rateLimit', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.rateLimit('ws-1', '1h');
      expect(key).toBe('workspace:ws-1:ratelimit:1h');
    });
  });

  describe('apiKey', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.apiKey('hash123');
      expect(key).toBe('apikey:hash123');
    });
  });

  describe('workerLock', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.workerLock('scheduler');
      expect(key).toBe('lock:worker:scheduler');
    });
  });

  describe('circuitBreaker', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.circuitBreaker('api.example.com');
      expect(key).toBe('circuit:api.example.com');
    });
  });

  describe('workerHeartbeat', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.workerHeartbeat('consumer', 'worker-1');
      expect(key).toBe('health:worker:consumer:worker-1');
    });
  });

  describe('activeWorkers', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.activeWorkers('scheduler');
      expect(key).toBe('health:workers:scheduler');
    });
  });

  describe('workspaceCache', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.workspaceCache('ws-1');
      expect(key).toBe('cache:workspace:ws-1');
    });
  });

  describe('quotaDaily', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.quotaDaily('ws-1', '2025-01-01');
      expect(key).toBe('quota:ws-1:daily:2025-01-01');
    });
  });

  describe('quotaMonthly', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.quotaMonthly('ws-1', '2025-01');
      expect(key).toBe('quota:ws-1:monthly:2025-01');
    });
  });

  describe('quotaBandwidth', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.quotaBandwidth('ws-1', '2025-01');
      expect(key).toBe('quota:ws-1:bandwidth:2025-01');
    });
  });

  describe('deliverySecret', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.deliverySecret('ws-1');
      expect(key).toBe('workspace:ws-1:delivery-secret');
    });
  });

  describe('deliverySecretOld', () => {
    it('should generate correct key format', () => {
      const key = RedisKeys.deliverySecretOld('ws-1');
      expect(key).toBe('workspace:ws-1:delivery-secret:old');
    });
  });
});

describe('checkRedisHealth', () => {
  it('should return true when Redis responds with PONG', async () => {
    const result = await checkRedisHealth();
    expect(result).toBe(true);
  });
});

describe('Dual Redis Clients', () => {
  describe('redis (API client)', () => {
    it('should be defined', () => {
      expect(redis).toBeDefined();
    });

    it('should have commandTimeout configured for API operations', () => {
      expect(redis.options?.commandTimeout).toBe(5000);
    });
  });

  describe('redisBlocking (Worker client)', () => {
    it('should be defined', () => {
      expect(redisBlocking).toBeDefined();
    });

    it('should NOT have commandTimeout (for blocking operations)', () => {
      expect(redisBlocking.options?.commandTimeout).toBeUndefined();
    });
  });

  describe('client separation', () => {
    it('should have two separate Redis instances', () => {
      expect(redis).not.toBe(redisBlocking);
    });
  });
});

describe('closeRedis', () => {
  it('should close both Redis clients', async () => {
    await closeRedis();

    expect(redis.quit).toHaveBeenCalled();
    expect(redisBlocking.quit).toHaveBeenCalled();
  });
});

describe('checkPipelineResults', () => {
  it('should return results when all operations succeed', () => {
    const results: [Error | null, unknown][] = [
      [null, 'OK'],
      [null, 1],
      [null, 'value'],
    ];

    const checked = checkPipelineResults(results, 'test context');
    expect(checked).toEqual(results);
  });

  it('should throw when results is null', () => {
    expect(() => checkPipelineResults(null, 'test context')).toThrow(
      'Pipeline execution returned null (test context)'
    );
  });

  it('should throw when any operation fails', () => {
    const results: [Error | null, unknown][] = [
      [null, 'OK'],
      [new Error('Operation failed'), null],
      [null, 'value'],
    ];

    expect(() => checkPipelineResults(results, 'test context')).toThrow(
      'Pipeline operations failed (test context): Operation 1: Operation failed'
    );
  });

  it('should aggregate multiple errors', () => {
    const results: [Error | null, unknown][] = [
      [new Error('Error 1'), null],
      [null, 'OK'],
      [new Error('Error 2'), null],
    ];

    expect(() => checkPipelineResults(results)).toThrow(
      'Pipeline operations failed: Operation 0: Error 1; Operation 2: Error 2'
    );
  });

  it('should work without context parameter', () => {
    const results: [Error | null, unknown][] = [
      [null, 'OK'],
    ];

    const checked = checkPipelineResults(results);
    expect(checked).toEqual(results);
  });
});

describe('execPipelineChecked', () => {
  it('should execute pipeline and return results on success', async () => {
    const mockResults: [Error | null, unknown][] = [
      [null, 'OK'],
      [null, 1],
    ];

    const mockPipeline = {
      exec: vi.fn().mockResolvedValue(mockResults),
    };

    const results = await execPipelineChecked(mockPipeline as any, 'test');
    expect(results).toEqual(mockResults);
    expect(mockPipeline.exec).toHaveBeenCalled();
  });

  it('should throw when pipeline exec returns null', async () => {
    const mockPipeline = {
      exec: vi.fn().mockResolvedValue(null),
    };

    await expect(execPipelineChecked(mockPipeline as any, 'test')).rejects.toThrow(
      'Pipeline execution returned null (test)'
    );
  });

  it('should throw when pipeline operations fail', async () => {
    const mockResults: [Error | null, unknown][] = [
      [null, 'OK'],
      [new Error('Redis error'), null],
    ];

    const mockPipeline = {
      exec: vi.fn().mockResolvedValue(mockResults),
    };

    await expect(execPipelineChecked(mockPipeline as any)).rejects.toThrow(
      'Pipeline operations failed: Operation 1: Redis error'
    );
  });
});
