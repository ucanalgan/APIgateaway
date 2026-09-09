-- KEYS[1] = key (hash: windowStart, count)
-- ARGV[1] = limit, ARGV[2] = windowMs, ARGV[3] = capacity (unused), ARGV[4] = now, ARGV[5] = cost
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])

local windowStart = math.floor(now / windowMs) * windowMs
local raw = redis.call('HMGET', KEYS[1], 'windowStart', 'count')
local storedWindowStart = tonumber(raw[1])
local count = tonumber(raw[2]) or 0

if storedWindowStart ~= windowStart then
  count = 0
end

local projected = count + cost
local allowed = projected <= limit
if allowed then
  count = projected
end

redis.call('HSET', KEYS[1], 'windowStart', windowStart, 'count', count)
redis.call('PEXPIRE', KEYS[1], windowMs)

local retryAfter = 0
if not allowed then
  retryAfter = windowStart + windowMs - now
end

return { allowed and 1 or 0, math.max(0, limit - count), retryAfter }
