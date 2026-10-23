-- Clients' notes on shared pages (FEATURE-SPECS 3). page = the shared page's path; anchor/fx/fy = the spot;
-- version = the published version the note was written on (3.5). Tris adds the column to older databases.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  page TEXT NOT NULL,
  anchor TEXT,
  fx REAL, fy REAL, px REAL, py REAL,
  text TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  version INTEGER
);
CREATE INDEX IF NOT EXISTS notes_page ON notes (page, created);
