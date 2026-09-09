-- KEYS[1] = queue key
-- ARGV[1] = limit, ARGV[2] = windowMs, ARGV[3] = capacity, ARGV[4] = now, ARGV[5] = cost
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local leakPerMs = limit / windowMs

local raw = redis.call('HMGET', KEYS[1], 'level', 'ts')
local level = tonumber(raw[1]) or 0
local lastLeakMs = tonumber(raw[2]) or now

local elapsed = math.max(0, now - lastLeakMs)
level = math.max(0, level - elapsed * leakPerMs)

local allowed = (level + cost) <= capacity
if allowed then
  level = level + cost
end

redis.call('HSET', KEYS[1], 'level', level, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / leakPerMs) + 1000)

local retryAfter = 0
if not allowed then
  retryAfter = math.ceil((level + cost - capacity) / leakPerMs)
end

return { allowed and 1 or 0, math.max(0, math.floor(capacity - level)), retryAfter }
