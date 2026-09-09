-- KEYS[1] = bucket key
-- ARGV[1] = limit, ARGV[2] = windowMs, ARGV[3] = capacity, ARGV[4] = now, ARGV[5] = cost
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local refillPerMs = limit / windowMs

local raw = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(raw[1])
local lastRefillMs = tonumber(raw[2])

if tokens == nil then
  tokens = capacity
  lastRefillMs = now
end

local elapsed = math.max(0, now - lastRefillMs)
local available = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = available >= cost
local remainingTokens = available
if allowed then
  remainingTokens = available - cost
end

redis.call('HSET', KEYS[1], 'tokens', remainingTokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refillPerMs) + 1000)

local retryAfter = 0
if not allowed then
  retryAfter = math.ceil((cost - available) / refillPerMs)
end

return { allowed and 1 or 0, math.floor(remainingTokens), retryAfter }
