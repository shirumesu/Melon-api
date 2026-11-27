-- Weekly new-collection counts for the schedule: each airing subject's
-- Bangumi collection total the first time in a week (Monday 00:00 Shanghai
-- time) melon-api had its details fresh.
CREATE TABLE collection_snapshots (
  week TEXT NOT NULL,
  subject INTEGER NOT NULL,
  total INTEGER NOT NULL,
  recorded INTEGER NOT NULL,
  PRIMARY KEY (week, subject)
);
