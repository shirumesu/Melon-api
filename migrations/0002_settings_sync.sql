-- MelonBanG settings sync: one settings object per Bangumi user.
CREATE TABLE settings_sync (
  user INTEGER PRIMARY KEY,
  rev INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated INTEGER NOT NULL
);
