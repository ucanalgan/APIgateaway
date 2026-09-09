-- KEYS[1] = key (hash: windowStart, currentCount, previousCount)
-- ARGV[1] = limit, ARGV[2] = windowMs, ARGV[3] = capacity (unused), ARGV[4] = now, ARGV[5] = cost
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])

local windowStart = math.floor(now / windowMs) * windowMs
local raw = redis.call('HMGET', KEYS[1], 'windowStart', 'currentCount', 'previousCount')
local storedWindowStart = tonumber(raw[1])
local currentCount = tonumber(raw[2]) or 0
local previousCount = tonumber(raw[3]) or 0

if storedWindowStart ~= windowStart then
  if storedWindowStart == windowStart - windowMs then
    previousCount = currentCount
  else
    previousCount = 0
  end
  currentCount = 0
end

local elapsedInWindow = now - windowStart
local overlap = math.max(0, (windowMs - elapsedInWindow) / windowMs)
local estimate = previousCount * overlap + currentCount

local allowed = (estimate + cost) <= limit
if allowed then
  currentCount = currentCount + cost
  estimate = previousCount * overlap + currentCount
end

redis.call('HSET', KEYS[1], 'windowStart', windowStart, 'currentCount', currentCount, 'previousCount', previousCount)
redis.call('PEXPIRE', KEYS[1], windowMs * 2)

local ratePerMs = limit / windowMs
local retryAfter = 0
if not allowed then
  retryAfter = math.ceil((estimate + cost - limit) / ratePerMs)
end

return { allowed and 1 or 0, math.max(0, math.floor(limit - estimate)), retryAfter }
