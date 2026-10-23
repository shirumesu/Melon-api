-- MelonBanG's own danmaku, keyed by Bangumi episode ID.
CREATE TABLE danmaku (
  id INTEGER PRIMARY KEY,
  episode INTEGER NOT NULL,
  time_ms INTEGER NOT NULL,
  mode INTEGER NOT NULL,
  color INTEGER NOT NULL,
  text TEXT NOT NULL,
  user INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX danmaku_episode ON danmaku (episode, time_ms);
CREATE INDEX danmaku_user ON danmaku (user, created);
