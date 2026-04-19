-- SnapMe Database Schema
-- Run this in Supabase SQL Editor: https://ldnltjjcyftbdtxvbrxt.supabase.co

-- Confessions table
CREATE TABLE IF NOT EXISTS confessions (
  confession_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 10 AND 280),
  timestamp BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  cast_hash TEXT,
  real_votes INT NOT NULL DEFAULT 0,
  fake_votes INT NOT NULL DEFAULT 0,
  views_count INT NOT NULL DEFAULT 0,
  total_tips_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  tip_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  submission_fid BIGINT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE
);

-- Votes table
CREATE TABLE IF NOT EXISTS votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confession_id UUID NOT NULL REFERENCES confessions(confession_id) ON DELETE CASCADE,
  voter_fid BIGINT NOT NULL,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('real', 'fake')),
  timestamp BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  UNIQUE(confession_id, voter_fid)
);

-- Tips table
CREATE TABLE IF NOT EXISTS tips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confession_id UUID NOT NULL REFERENCES confessions(confession_id) ON DELETE CASCADE,
  tipper_fid BIGINT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  timestamp BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);

-- Views table
CREATE TABLE IF NOT EXISTS views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confession_id UUID NOT NULL REFERENCES confessions(confession_id) ON DELETE CASCADE,
  viewer_fid BIGINT NOT NULL,
  UNIQUE(confession_id, viewer_fid)
);

-- Daily submissions table (anti-abuse)
CREATE TABLE IF NOT EXISTS daily_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fid BIGINT NOT NULL,
  date TEXT NOT NULL,
  count INT NOT NULL DEFAULT 1,
  UNIQUE(fid, date)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_confessions_status ON confessions(status);
CREATE INDEX IF NOT EXISTS idx_confessions_timestamp ON confessions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_votes_confession ON votes(confession_id);
CREATE INDEX IF NOT EXISTS idx_tips_confession ON tips(confession_id);
CREATE INDEX IF NOT EXISTS idx_views_confession ON views(confession_id);

-- Row Level Security (disable for service key access)
ALTER TABLE confessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tips ENABLE ROW LEVEL SECURITY;
ALTER TABLE views ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_submissions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "service_all" ON confessions FOR ALL USING (true);
CREATE POLICY "service_all" ON votes FOR ALL USING (true);
CREATE POLICY "service_all" ON tips FOR ALL USING (true);
CREATE POLICY "service_all" ON views FOR ALL USING (true);
CREATE POLICY "service_all" ON daily_submissions FOR ALL USING (true);
