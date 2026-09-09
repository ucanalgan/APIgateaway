-- KEYS[1] = zset key (member format "<timestamp>:<cost>:<seq>")
-- ARGV[1] = limit, ARGV[2] = windowMs, ARGV[3] = capacity (unused), ARGV[4] = now, ARGV[5] = cost
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])

local windowStart = now - windowMs
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', windowStart)

local entries = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
local currentCount = 0
local oldestTs = nil
for i = 1, #entries, 2 do
  local weight = tonumber(string.match(entries[i], ':(%d+):%d+$')) or 1
  currentCount = currentCount + weight
  if oldestTs == nil then
    oldestTs = tonumber(entries[i + 1])
  end
end

local allowed = (currentCount + cost) <= limit
if allowed then
  local seqKey = KEYS[1] .. ':seq'
  local seq = redis.call('INCR', seqKey)
  redis.call('PEXPIRE', seqKey, windowMs)
  redis.call('ZADD', KEYS[1], now, now .. ':' .. cost .. ':' .. seq)
  redis.call('PEXPIRE', KEYS[1], windowMs)
  currentCount = currentCount + cost
end

local retryAfter = 0
if not allowed then
  retryAfter = (oldestTs or now) + windowMs - now
end

return { allowed and 1 or 0, math.max(0, limit - currentCount), retryAfter }
